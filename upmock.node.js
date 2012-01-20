var config = require('./config').config;
var http = require('http');
var request = require('request');
var hashlib = require("hashlib");
var _ = require('underscore');

var couchAuthUrl = 'http://' + config.couch.admin.name + ':' +
  config.couch.admin.pass + '@' + config.couch.host + ':' + config.couch.port;

var couchUrl = 'http://' + config.couch.host + ':' + config.couch.port + '/';

console.log(couchAuthUrl);

var app = require('express').createServer();
var nano = require('nano')(couchAuthUrl);

// Homepage!
app.get('/', function(_, res) {
  res.sendfile(__dirname + '/public/index.html');
});


app.get('/ping', function(_, res) {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('pong\n');
});


// Proxy all requests from /couch/* to the root of the couch host
app.all('/couch/*', function(req, res) {
  var url = couchUrl + req.url.slice(7);
  var x = request(url);
  req.pipe(x);
  x.pipe(res);
});

// Proxy login requests to couch
app.post('/login', function(req, client) {
  fetchJSONBody(req, function(post) {
    loginRequest(post.user, post.password, function(err, res, body) {
      if (res.statusCode === 401) {
        reply(client, 401, {error: 'invalid login'});
      } else {
        reply(client, 200, {ok: true}, {'Set-Cookie': res.headers['set-cookie']});
      }
    });
  });
});


app.get('/user/:id/', function(_, res) {
  res.sendfile(__dirname + '/public/index.html');
});

// Serves the main application index.html, this path needs a check
// for auth errrors to give the user a login screen if they arent
// logged in
app.get('/user/:id/:db/', function(req, res){
  request.get({
    headers: {'Cookie': req.headers.cookie || ''},
    uri: couchUrl + 'upmock-' + req.params.id
  }, function(err, resp, body) {
    if (resp.statusCode !== 200) {
      res.sendfile(__dirname + '/public/index.html');
    } else {
      res.sendfile(__dirname + '/public/upmock.html');
    }
  });
});


// Register a user, check their name isnt taken and if not, create a new
// user, create a database for them and setup security
// This needs retry mechanisms built in, other failures are transient but if
// this fails then it can be left inconsistent
app.post('/register', function(req, client) {

  fetchJSONBody(req, function(post) {

    console.log('REGISTRATION: ' + post.user);

    var users = nano.use('_users');
    var name = post.user;
    var userName = 'org.couchdb.user:' + post.user;

    areValidCredentials(users, userName, post, function(areValid, reason) {

      if (!areValid) {

        reply(client, reason.status, reason.json);

      } else {
        createUserDoc(userName, name, post.password, function(user_doc) {

          users.insert(user_doc, function(err, body, hdrs) {

            if (err) {
              return reply(client, 503, {error: 'unknown'});
            }

            loginRequest(post.user, post.password, function(error, res, body) {
              createAccount(name, function(err) {
                if (err) {
                  return reply(client, 501, {error: 'unknown'});
                }
                reply(client, 201, {ok: true}, {
                  'Set-Cookie': res.headers['set-cookie']
                });
              });
            });
          });
        });
      }
    });
  });
});

app.get('*', function(req, res) {
  res.sendfile(__dirname + '/public' + req.params[0]);
});



function reply(client, status, content, hdrs) {
  var headers = _.extend({'Content-Type': 'application/json'}, hdrs);
  client.writeHead(status, headers);
  client.end(JSON.stringify(content));
}


function loginRequest(username, password, callback) {
  request({
    method: 'POST',
    uri: couchUrl + '_session',
    body: 'name=' + username + '&password=' + password,
    headers: {'content-type': 'application/x-www-form-urlencoded' }
  }, callback);
}

function fetchJSONBody(req, callback) {
  var content = '';
  req.addListener('data', function(data) {
    content += data;
  });
  req.addListener('end', function() {
    callback(JSON.parse(content));
  });
}

function createUserDoc(id, name, password, callback) {
  nano.request({db: "_uuids"}, function(_, uuids) {
    var salt = uuids.uuids[0];
    callback({
      _id: id,
      name: name,
      type: 'user',
      roles: [],
      salt: salt,
      password_sha: hashlib.sha1(password + salt)
    });
  });
}

// Ensure the users database exists and has the correct
// security credentials
function createAccount(name, callback) {

  nano.request({
    db: 'upmock-' + name,
    method: 'PUT',
    headers: {'cookie': null}
  }, function (error, body, headers) {

    if (!(headers['status-code'] === 201 || headers['status-code'] === 412)) {
      return callback(new Error('screwed'));
    }

    var security = {
      admins: { names: [name], roles: []},
      readers: { names: [name], roles: []}
    };

    nano.request({
      method: 'PUT',
      db: 'upmock-' + name,
      path: '_security',
      body: security
    }, function(err, body, hdrs) {
      if (hdrs['status-code'] !== 200) {
        throw(err);
      }
      if (callback) {
        callback(null);
      }
    });

  });
}

function areValidCredentials(usersTable, id, post, callback) {

  if (post.password !== post.confirm_password) {
    callback(false, {status: 400, json: {error: 'Passwords do not match'}});

  } else if (!/^[A-Za-z0-9_]{3,20}$/.test(post.user)) {
    callback(false, {status: 400, json: {
      error: 'Invalid username'
    }});

  } else if (!/^[A-Za-z0-9_]{3,20}$/.test(post.password)) {
    callback(false, {status: 400, json: {
      error: 'Invalid password'
    }});

  } else {
    usersTable.get(id, function(err, _, res) {
      if (res['status-code'] === 200) {
        callback(false, {status: 409, json: {error: 'Username is in use'}});
      } else {
        callback(true);
      }
    });
  }
}

app.listen(config.node.port);
console.log('Server running at http://' + config.node.host + ':' + config.node.port);