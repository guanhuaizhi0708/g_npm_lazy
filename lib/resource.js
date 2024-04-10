var fs = require('fs'),
    coreUrl = require('url'),
    path = require('path'),
    // for http get
    request = require('request'),
    qs = require('querystring'),

    Lifecycle = require('./lifecycle.js'),
    verify = require('./verify.js'),
    microee = require('microee'),
    Cache;

// maximum age before an index is refreshed from npm
var cacheAge = 60 * 60 * 1000,
    maxRetries = 5,
    timeout = 10000,
    rejectUnauthorized = true,
    logger = console,
    proxy = {};

// global caches
var resourceCache = {},
    guard = new Lifecycle(),
    lastUpdated = {};

// A resource is a representation of a particular remote endpoint
// The main benefit for combining cross-cutting concerns into one object
// is that it makes expressing the various cases:
// 1) blocking while fetch is pending
// 2) retrying when a checksum fails (for a tarfile)
// 3) delaying the return when the resource is outdated (for a index.json)
//
// easier than trying to juggle these responsibilities in the caching logic

function Resource(url, auth) {
  this.url = url;
  this.auth = auth;

  this.retries = 0;

  var parts = coreUrl.parse(url);
  if (path.extname(parts.pathname) == '.tgz') {
    this.type = 'tar';
    this.basename = path.basename(parts.pathname);
  } else {
    this.type = 'index';
  }

  this.err = null;
  this.fetchTimer = null;
}

microee.mixin(Resource);

Resource.configure = function(opts) {
  if (typeof opts.cache !== 'undefined') {
    Cache = opts.cache;
  }
  if (typeof opts.cacheAge !== 'undefined') {
    cacheAge = opts.cacheAge;
  }
  if (typeof opts.maxRetries !== 'undefined') {
    maxRetries = opts.maxRetries;
  }
  if (typeof opts.timeout !== 'undefined') {
    timeout = opts.timeout;
  }
  if (typeof opts.rejectUnauthorized !== 'undefined') {
    rejectUnauthorized = opts.rejectUnauthorized;
  }
  if (typeof opts.logger !== 'undefined') {
    logger = opts.logger;
  }
  if (typeof opts.proxy !== 'undefined') {
    proxy = opts.proxy;
  }
};

Resource.prototype.exists = function() {
  // logger.log('exists', this.url, 'GET', Cache.lookup(this.url, 'GET'));
  return this.lookup().path;
};

Resource.prototype.lookup = function() {
  return Cache.lookup(this.url, 'GET');
};

Resource.prototype.isUpToDate = function() {
  if (cacheAge < 0) {
    return true;
  }
  var maxAge = new Date() - cacheAge,
      isUpToDate = (lastUpdated[this.url] &&
                    lastUpdated[this.url] > maxAge);
  return isUpToDate;
};

Resource.prototype.getPackageName = function() {
  var parts = coreUrl.parse(this.url);
  var dirs = path.dirname(parts.pathname).split('/').filter(Boolean);
  if (dirs[0].charAt(0) === '@') {
    // https://github.com/npm/npm/blob/2a5977e0c65b244e92d848fcd56f2f80ba8cdf3b/lib/utils/map-to-registry.js#L16
    return dirs.slice(0, 2).join('%2f');
  }
  return dirs[0];
};

// one API
Resource.prototype.getReadablePath = function(onDone) {
  var self = this;
  // try to find a shortcut
  if (!guard.isBlocking(self.url)) {
    if (self.type == 'index' && self.exists()) {
      // is this a index file?
      if (self.isUpToDate()) {
        self.emit('fetch-cached');
        // is the index up to date?
        // yes: return readable stream
        return onDone(null, self.exists(), self.lookup().etag);
      }
    }

    if (self.type == 'tar' && self.exists()) {
      self.emit('fetch-cached');
      // is this a tarfile and is it in the index?
      // yes: check sha1 hash
      var Package = require('./package.js');
      return Package.getIndex(self.getPackageName(), self.auth, function(err, data) {
        if (err) {
          return onDone(err, null, null);
        }
        var expectedHash = verify.getSha(self.basename, data);
        verify.check(self.exists(), function(err, actualHash) {
          if (err) {
            return onDone(err, null, null);
          }
          if (actualHash === expectedHash) {
            return onDone(null, self.exists(), self.lookup().etag); // return readable stream if file is good
          }

          // otherwise, cache is corrupted somehow, so bust cache and retry
          logger.log('Cached package is corrupt. Refetching ' + self.url);
          Cache.junk(self.url);
          self.getReadablePath(onDone);
        });
      });
    }
  }

  var removeAtEnd = self.exists();

  // queue the callback
  guard.onRelease(this.url, function() {
    // attempt to remove the old file at the end
    // but do not do this if we fail and decide to reuse an old index
    if (self.exists() && removeAtEnd && removeAtEnd != self.exists()) {
      Resource.removeFile(removeAtEnd);
    }
    if (self.err && !self.exists()) {
      return onDone(self.err, null, null);
    }
    // return readable path
    onDone(null, self.exists(), self.lookup().etag);
  });

  // are we blocking? => nothing more to do so return
  if (guard.isBlocking(self.url)) {
    logger.log('Request is pending, blocking ' + self.url);
    return;
  }

  // else: queue a get
  guard.block(self.url);
  this.retries = 0;
  this.err = null;
  this.retry();
};

Resource.prototype.retry = function() {
  var self = this;
  self.retries++;
  if (self.retries > maxRetries || (self.err && self.err.statusCode === 404)) {
    // if the second fetch fails, and we're fetching an index,
    // and we have (any) cached version then use that
    // logger.log(self.retries, self.type, self.exists());
    if (self.type == 'index' && self.exists()) {
      self.emit('fetch-cached');
      Cache.save();
      return guard.release(self.url);
    }

    // for non-index files, and index files that we don't have,
    // if we exhaust the number of retries then 500
    // did we exceed the max retries? => throw
    if (!self.err) {
      self.err = new Error();
    }
    self.err.message = 'URL is not in the npm_lazy cache, and it cannot be fetched (max retries exhausted): ' + self.url;

    // We need to read the whole stream because we want to potentially
    // respond to multiple clients with the same message.
    // Non-200 responses should be small regardless.
    var readToEnd = function(stream, done) {
      var resp = '';
      stream.on('data', function(content) {
        resp += content;
      });
      stream.on('end', function() {
        return done(resp);
      });
    };

    var done = function(content) {
      self.err.contentStream = null;
      self.err.content = content;
      Cache.save();
      return guard.release(self.url);
    };

    if (self.err.contentStream) {
      return readToEnd(self.err.contentStream, done);
    }
    return done('{ "error": "Unknown error" }');
  }

  this.fetchTimer = setTimeout(function() {
    self._afterFetch(new Error('Request timed out (' + timeout + 'ms)'));
  }, timeout);

  this._fetchTask(function(err, readableStream) {
    self._afterFetch(err, readableStream);
  });
};

Resource.prototype._afterFetch = function(err, readableStream) {
  var self = this;

  clearTimeout(self.fetchTimer);
  // queue returned:

  // did the request fail?
  if (err) {
    err.contentStream = readableStream;
    self.emit('fetch-error', err, self.retries, maxRetries);
    // RETRY
    return self.retry();
  }

  // resource fetch not modified:
  if (readableStream.statusCode === 304) {
    // We can rely on the data already in the cache.
    // No more operations required.
    logger.log('[304] ' + self.url);
    lastUpdated[self.url] = new Date();
    guard.release(self.url);
    return;
  }

  // resource fetch not successful:
  if (readableStream.statusCode !== 200) {
    self.err = new Error(readableStream.statusCode + ' getting from upstream: ' + self.url);
    self.err.statusCode = readableStream.statusCode;
    self.err.contentStream = readableStream;
    self.emit('fetch-error-response', self.err, self.retries, maxRetries);
    logger.log('[' + readableStream.statusCode + '] ' + self.url);

    // RETRY
    return self.retry();
  }

  // resource fetch OK:
  if (readableStream.headers) {
    self.etag = readableStream.headers.etag;
  }

  // write to disk
  var cachename = Cache.filename(),
      out = fs.createWriteStream(cachename, {flags: 'w'});

  // 0.8.x: "close"
  // 0.10.x: "finish"
  var emittedDone = false;
  function emitDone() {
    if (!emittedDone) {
      emittedDone = true;

      // now validate it

      if (self.type == 'index') {
        // is this a indexfile?
        try {
          // check that it's JSON => store => release
          JSON.parse(fs.readFileSync(cachename).toString());
        } catch (e) {
          // delete
          Resource.removeFile(cachename);
          // RETRY
          return self.retry();
        }
        // mark as OK, return all pending callback
        Cache.complete(self.url, 'GET', cachename, self.etag);
        // set last updated
        lastUpdated[self.url] = new Date();
        guard.release(self.url);
        return;
      }

      if (self.type == 'tar') {
        // is this a tarfile?
        // read the expected checksum
        var Package = require('./package.js');

        Package.getIndex(self.getPackageName(), self.auth, function(err, data) {
          if (err) {
            self.err = err;
            return guard.release(self.url);
          }

          // logger.log('PACKAGE INDEX', data);

          // check that the checksum matches => store => release
          try {
            var expected = verify.getSha(self.basename, data);
          } catch (error) {
            self.err = error;
            return guard.release(self.url);
          }
          verify.check(cachename, function(err, actual) {
            if (err || actual !== expected) {
              logger.error('SHASUM - ' + self.url +
                ' - expected: ' + expected +
                ', actual: ' + actual);
              logger.error('ERROR: npm SHASUM mismatch for ' + self.basename);
              // delete
              Resource.removeFile(cachename);
              // RETRY
              return self.retry();
            } else {
              // must be OK
              logger.log('[done][SHASUM OK] added to cache',
                self.url, self.basename, cachename);
              // mark as OK, return all pending callback
              Cache.complete(self.url, 'GET', cachename);
              guard.release(self.url);
              return;
            }
          });

        });
      }
    }
  }
  out.once('close', emitDone);
  out.once('finish', emitDone);

  readableStream.pipe(out);
};

Resource.removeFile = function(filepath) {
  if (fs.existsSync(filepath)) {
    try {
      fs.unlinkSync(filepath);
    } catch (e) { }
  }
};

Resource.prototype._fetchTask = function(onDone) {
  var self = this;
  var opts = {
        url: coreUrl.parse(this.url),
        method: 'GET',
        headers: {}
      },
      req,
      isHttps = (opts.url.protocol == 'https:'),
      proxyConfig = proxy[(isHttps ? 'https' : 'http')];

  if (proxyConfig && proxyConfig.hostname) {
      opts.proxy = proxyConfig;
  }

  if (!rejectUnauthorized && isHttps) {
    opts.strictSSL = false;
  }

  if (self.lookup() && self.lookup().etag) {
    opts.headers['if-none-match'] = self.lookup().etag;
  }

  if (self.auth) {
    opts.headers['authorization'] = self.auth;
  }

  logger.log('[GET] ' + this.url);

  req = request.get(opts);
  req.on('error', function(err) {
    onDone(err);
  });

  req.on('response', function(res) {
    onDone(null, res);
  });
};

// one instance of a resource per url

Resource.get = function(url, auth) {
  if (!resourceCache[url]) {
    resourceCache[url] = new Resource(url, auth);
  }
  return resourceCache[url];
};

module.exports = Resource;
