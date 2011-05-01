/*
  node-http-proxy.js: http proxy for node.js

  Copyright (c) 2010 Charlie Robbins, Mikeal Rogers, Marak Squires, Fedor Indutny

  Permission is hereby granted, free of charge, to any person obtaining
  a copy of this software and associated documentation files (the
  "Software"), to deal in the Software without restriction, including
  without limitation the rights to use, copy, modify, merge, publish,
  distribute, sublicense, and/or sell copies of the Software, and to
  permit persons to whom the Software is furnished to do so, subject to
  the following conditions:

  The above copyright notice and this permission notice shall be
  included in all copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
  EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
  MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
  NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
  LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
  OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
  WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

*/

var util = require('util'),
    http = require('http'),
    events = require('events'),
    winston = require('winston'),
    ProxyTable = require('./proxy-table').ProxyTable,
    maxSockets = 100;

//
// ### Version 0.4.2
//
exports.version = [0, 4, 2];

//
// ### function _getAgent (host, port)
// #### @host {string} Host of the agent to get
// #### @port {number} Port of the agent to get
// Retreives an agent from the `http` module
// and sets the `maxSockets` property appropriately.
//
function _getAgent (host, port) {
  //
  // TODO (indexzero): Make this configurable for http / https
  //
  var agent = http.getAgent(host, port);
  agent.maxSockets = maxSockets;
  return agent;
}

//
// ### function getMaxSockets ()
// Returns the maximum number of sockets
// allowed on __every__ outgoing request
// made by __all__ instances of `HttpProxy`
//
exports.getMaxSockets = function () {
  return maxSockets;
};

//
// ### function setMaxSockets ()
// Sets the maximum number of sockets
// allowed on __every__ outgoing request
// made by __all__ instances of `HttpProxy`
//
exports.setMaxSockets = function (value) {
  maxSockets = value;
};

//
// ### function createServer ([port, host, options, handler])
// #### @port {number} **Optional** Port to use on the proxy target host.
// #### @host {string} **Optional** Host of the proxy target.
// #### @options {Object} **Optional** Options for the HttpProxy instance used
// #### @handler {function} **Optional** Request handler for the server
// Returns a server that manages an instance of HttpProxy. Flexible arguments allow for:
//
// * `httpProxy.createServer(9000, 'localhost')`
// * `httpProxy.createServer(9000, 'localhost', options)
// * `httpPRoxy.createServer(function (req, res, proxy) { ... })`
//
exports.createServer = function () {
  var args, callback, port, host, forward,
      silent, options, proxy, server;

  args = Array.prototype.slice.call(arguments);
  callback = typeof args[args.length - 1] === 'function' && args.pop();

  if (args.length >= 2) {
    port = args[0];
    host = args[1];
    options = args[2] || {};
  }
  else if (args.length === 1) {
    options = args[0] || {};
    if (!options.router && !callback) {
      throw new Error('Cannot create server with no router and no callback');
    }
  }

  proxy = new HttpProxy(options);
  server = http.createServer(function (req, res) {
    winston.verbose('Incoming HTTP request to: ' + req.headers.host + req.url);

    // If we were passed a callback to process the request
    // or response in some way, then call it.
    if (callback) {
      callback(req, res, proxy);
    }
    else if (port && host) {
      winston.verbose('Proxying HTTP request to: ' + host + ':' + port);
      proxy.proxyRequest(req, res, port, host);
    }
    else if (proxy.proxyTable) {
      winston.verbose('Proxying request using proxy table');
      proxy.proxyRequest(req, res);
    }
    else {
      throw new Error('Cannot proxy without port, host, or router.')
    }
  });

  server.on('close', function () {
    proxy.close();
  });

  proxy.on('routes', function (routes) {
    server.emit('routes', routes);
  });

  if (!callback) {
    // WebSocket support: if callback is empty tunnel
    // websocket request automatically
    server.on('upgrade', function(req, socket, head) {
      // Tunnel websocket requests too

      proxy.proxyWebSocketRequest(port, host);
    });
  }

  return server;
};

//
// ### function HttpProxy (options)
// #### @options {Object} Options for this instance.
// Constructor function for new instances of HttpProxy responsible
// for managing the life-cycle of streaming reverse proxyied HTTP requests.
//
// Example options:
//
//      {
//        router: {
//          'foo.com': 'localhost:8080',
//          'bar.com': 'localhost:8081'
//        },
//        forward: {
//          host: 'localhost',
//          port: 9001
//        }
//      }
//
var HttpProxy = exports.HttpProxy = function (options) {
  events.EventEmitter.call(this);

  options = options || {};
  this.options = options;

  if (options.router) {
    var self = this;
    this.proxyTable = new ProxyTable(options.router, options.silent, options.hostnameOnly);
    this.proxyTable.on('routes', function (routes) {
      self.emit('routes', routes);
    });
  }
};

// Inherit from events.EventEmitter
util.inherits(HttpProxy, events.EventEmitter);

//
// ### function buffer (obj)
// #### @obj {Object} Object to pause events from
// Buffer `data` and `end` events from the given `obj`.
// Consumers of HttpProxy performing async tasks
// __must__ utilize this utility, to re-emit data once
// the async operation has completed, otherwise these
// __events will be lost.__
//
//      var buffer = httpProxy.buffer(req);
//      fs.readFile(path, function(){
//         httpProxy.proxyRequest(req, res, host, port, buffer);
//      });
//
// __Attribution:__ This approach is based heavily on
// [Connect](https://github.com/senchalabs/connect/blob/master/lib/utils.js#L157).
// However, this is not a big leap from the implementation in  node-http-proxy < 0.4.0.
// This simply chooses to manage the scope of  the events on a new Object literal as opposed to
// [on the HttpProxy instance](https://github.com/nodejitsu/node-http-proxy/blob/v0.3.1/lib/node-http-proxy.js#L154).
//
HttpProxy.prototype.buffer = function (obj) {
  var onData, onEnd, events = [];

  obj.on('data', onData = function (data, encoding) {
    events.push(['data', data, encoding]);
  });

  obj.on('end', onEnd = function (data, encoding) {
    events.push(['end', data, encoding]);
  });

  return {
    end: function () {
      obj.removeListener('data', onData);
      obj.removeListener('end', onEnd);
    },
    resume: function () {
      this.end();
      for (var i = 0, len = events.length; i < len; ++i) {
        obj.emit.apply(obj, events[i]);
      }
    }
  };
};

//
// ### function close ()
// Frees the resources associated with this instance,
// if they exist.
//
HttpProxy.prototype.close = function () {
  if (this.proxyTable) this.proxyTable.close();
};

//
// ### function proxyRequest (req, res, [port, host, paused])
// #### @req {ServerRequest} Incoming HTTP Request to proxy.
// #### @res {ServerResponse} Outgoing HTTP Request to write proxied data to.
// #### @port {number} **Optional** Port to use on the proxy target host.
// #### @host {string} **Optional** Host of the proxy target.
// #### @buffer {Object} **Optional** Result from `httpProxy.buffer(req)`
//
HttpProxy.prototype.proxyRequest = function (req, res, port, host, buffer) {
  var self = this, reverseProxy, location, errState = false, opts;

  //
  // Check the proxy table for this instance to see if we need
  // to get the proxy location for the request supplied. We will
  // always ignore the proxyTable if an explicit `port` and `host`
  // arguments are supplied to `proxyRequest`.
  //
  if (this.proxyTable && !host) {
    location = this.proxyTable.getProxyLocation(req);

    //
    // If no location is returned from the ProxyTable instance
    // then respond with `404` since we do not have a valid proxy target.
    //
    if (!location) {
      res.writeHead(404);
      return res.end();
    }

    //
    // When using the ProxyTable in conjunction with an HttpProxy instance
    // only the following arguments are valid:
    //
    // * `proxy.proxyRequest(req, res, port, host, buffer)`: This will be skipped
    // * `proxy.proxyRequest(req, res, buffer)`: Buffer will get updated appropriately
    // * `proxy.proxyRequest(req, res)`: No effect `undefined = undefined`
    //
    buffer = port;
    port = location.port;
    host = location.host;
  }

  //
  // If forwarding is enabled for this instance, foward proxy the
  // specified request to the address provided in `this.options.forward`
  //
  if (this.options.forward) {
    winston.verbose('Forwarding HTTP request to: ' + this.options.forward.host + ':' + this.options.forward.port);
    this._forwardRequest(req);
  }

  //
  // #### function proxyError (err)
  // #### @err {Error} Error contacting the proxy target
  // Short-circuits `res` in the event of any error when
  // contacting the proxy target at `host` / `port`.
  //
  function proxyError(err) {
    errState = true;

    //
    // Emit an `error` event, allowing the application to use custom
    // error handling. The error handler should end the response.
    //
    if (self.emit('proxyError', err, req, res)) {
      return;
    }

    res.writeHead(500, { 'Content-Type': 'text/plain' });

    if (req.method !== 'HEAD') {
      //
      // This NODE_ENV=production behavior is mimics Express and
      // Connect.
      //
      if (process.env.NODE_ENV === 'production') {
        res.write('Internal Server Error');
      }
      else {
        res.write('An error has occurred: ' + JSON.stringify(err));
      }
    }

    res.end();
  }

  var opts = {
    host: host,
    port: port,
    agent: _getAgent(host, port),
    method: req.method,
    path: req.url,
    headers: req.headers
  };

  // Force the `connection` header to be 'close' until
  // node.js core re-implements 'keep-alive'.
  opts.headers['connection'] = 'close';

  // Open new HTTP request to internal resource with will act as a reverse proxy pass
  reverseProxy = http.request(opts, function (response) {

    // Process the `reverseProxy` `response` when it's received.
    if (response.headers.connection) {
      if (req.headers.connection) response.headers.connection = req.headers.connection;
      else response.headers.connection = 'close';
    }

    // Set the headers of the client response
    res.writeHead(response.statusCode, response.headers);

    // `response.statusCode === 304`: No 'data' event and no 'end'
    if (response.statusCode === 304) {
      return res.end();
    }

    // For each data `chunk` received from the `reverseProxy`
    // `response` write it to the outgoing `res`.
    response.on('data', function (chunk) {
      if (req.method !== 'HEAD') {
        res.write(chunk);
      }
    });

    // When the `reverseProxy` `response` ends, end the
    // corresponding outgoing `res` unless we have entered
    // an error state. In which case, assume `res.end()` has
    // already been called and the 'error' event listener
    // removed.
    response.on('end', function () {
      if (!errState) {
        reverseProxy.removeListener('error', proxyError);
        res.end();
      }
    });
  });

  // Handle 'error' events from the `reverseProxy`.
  reverseProxy.once('error', proxyError);

  // For each data `chunk` received from the incoming
  // `req` write it to the `reverseProxy` request.
  req.on('data', function (chunk) {
    if (!errState) {
      reverseProxy.write(chunk);
    }
  });

  //
  // When the incoming `req` ends, end the corresponding `reverseProxy`
  // request unless we have entered an error state.
  //
  req.on('end', function () {
    if (!errState) {
      reverseProxy.end();
    }
  });

  // If we have been passed buffered data, resume it.
  if (buffer && !errState) {
    buffer.resume();
  }
};

//
// ### @private function _forwardRequest (req)
// #### @req {ServerRequest} Incoming HTTP Request to proxy.
// Forwards the specified `req` to the location specified
// by `this.options.forward` ignoring errors and the subsequent response.
//
HttpProxy.prototype._forwardRequest = function (req) {
  var self = this, port, host, forwardProxy, opts;

  port = this.options.forward.port;
  host = this.options.forward.host;

  opts = {
    host: host,
    port: port,
    agent: _getAgent(host, port),
    method: req.method,
    path: req.url,
    headers: req.headers
  };

  // Force the `connection` header to be 'close' until
  // node.js core re-implements 'keep-alive'.
  opts.headers['connection'] = 'close';

  // Open new HTTP request to internal resource with will act as a reverse proxy pass
  forwardProxy = http.request(opts, function (response) {
    //
    // Ignore the response from the forward proxy since this is a 'fire-and-forget' proxy.
    // Remark (indexzero): We will eventually emit a 'forward' event here for performance tuning.
    //
  });

  // Add a listener for the connection timeout event.
  //
  // Remark: Ignoring this error in the event
  //         forward target doesn't exist.
  //
  forwardProxy.once('error', function (err) { });

  // Chunk the client request body as chunks from the proxied request come in
  req.on('data', function (chunk) {
    forwardProxy.write(chunk);
  })

  // At the end of the client request, we are going to stop the proxied request
  req.on('end', function () {
    forwardProxy.end();
  });
};

HttpProxy.prototype.proxyWebSocketRequest = function (port, server, host, data) {
  var self = this, req = self.req, socket = self.sock, head = self.head,
      headers = new _headers(req.headers), CRLF = '\r\n';

  // Will generate clone of headers
  // To not change original
  function _headers(headers) {
    var h = {};
    for (var i in headers) {
      h[i] = headers[i];
    }
    return h;
  }

  // WebSocket requests has method = GET
  if (req.method !== 'GET' || headers.upgrade.toLowerCase() !== 'websocket') {
    // This request is not WebSocket request
    return;
  }

  // Turn of all bufferings
  // For server set KeepAlive
  // For client set encoding
  function _socket(socket, server) {
    socket.setTimeout(0);
    socket.setNoDelay(true);
    if (server) {
      socket.setKeepAlive(true, 0);
    }
    else {
      socket.setEncoding('utf8');
    }
  }

  // Client socket
  _socket(socket);

  // If host is undefined
  // Get it from headers
  if (!host) {
    host = headers.Host;
  }

  // Remote host address
  var remote_host = server + (port - 80 === 0 ? '' : ':' + port);

  // Change headers
  headers.Host = remote_host;
  headers.Origin = 'http://' + remote_host;

  // Open request
  var p = manager.getPool(port, server);

  p.getClient(function(client) {
    // Based on 'pool/main.js'
    var request = client.request('GET', req.url, headers);

    var errorListener = function (error) {
      client.removeListener('error', errorListener);

      // Remove the client from the pool's available clients since it has errored
      p.clients.splice(p.clients.indexOf(client), 1);
      socket.end();
    }

    // Not disconnect on update
    client.on('upgrade', function(request, remote_socket, head) {
      // Prepare socket
      _socket(remote_socket, true);

      // Emit event
      onUpgrade(remote_socket);
    });

    client.on('error', errorListener);
    request.on('response', function (response) {
      response.on('end', function () {
        client.removeListener('error', errorListener);
        client.busy = false;
        p.onFree(client);
      })
    })
    client.busy = true;

    var handshake;
    request.socket.on('data', handshake = function(data) {
      // Handshaking

      // Ok, kind of harmfull part of code
      // Socket.IO is sending hash at the end of handshake
      // If protocol = 76
      // But we need to replace 'host' and 'origin' in response
      // So we split data to printable data and to non-printable
      // (Non-printable will come after double-CRLF)
      var sdata = data.toString();

      // Get Printable
      sdata = sdata.substr(0, sdata.search(CRLF + CRLF));

      // Get Non-Printable
      data = data.slice(Buffer.byteLength(sdata), data.length);

      // Replace host and origin
      sdata = sdata.replace(remote_host, host)
                   .replace(remote_host, host);

      try {
        // Write printable
        socket.write(sdata);

        // Write non-printable
        socket.write(data);
      }
      catch (e) {
        request.end();
        socket.end();
      }

      // Catch socket errors
      socket.on('error', function() {
        request.end();
      });

      // Remove data listener now that the 'handshake' is complete
      request.socket.removeListener('data', handshake);
    });

    // Write upgrade-head
    try {
      request.write(head);
    }
    catch(e) {
      request.end();
      socket.end();
    }
    self.unwatch(socket);
  });

  // Request

  function onUpgrade(reverse_proxy) {
    var listeners = {};

    // We're now connected to the server, so lets change server socket
    reverse_proxy.on('data', listeners._r_data = function(data) {
      // Pass data to client
      if (socket.writable) {
        try {
          socket.write(data);
        }
        catch (e) {
          socket.end();
          reverse_proxy.end();
        }
      }
    });

    socket.on('data', listeners._data = function(data) {
      // Pass data from client to server
      try {
        reverse_proxy.write(data);
      }
      catch (e) {
        reverse_proxy.end();
        socket.end();
      }
    });

    // Detach event listeners from reverse_proxy
    function detach() {
      reverse_proxy.removeListener('close', listeners._r_close);
      reverse_proxy.removeListener('data', listeners._r_data);
      socket.removeListener('data', listeners._data);
      socket.removeListener('close', listeners._close);
    }

    // Hook disconnections
    reverse_proxy.on('end', listeners._r_close = function() {
      socket.end();
      detach();
    });

    socket.on('end', listeners._close = function() {
      reverse_proxy.end();
      detach();
    });
  };
};