var restify = require('restify');  //package for API routes
var pg = require('pg');  //package for SQL db

// return integer column values as numbers not strings
// See https://github.com/brianc/node-postgres/wiki/pg#pgdefaultsparseint8
// and https://github.com/brianc/node-postgres/issues/378.
pg.defaults.parseInt8 = true;

/*
    ToDo:
        passportJS, //user auth
*/

// get db string from environmental var in this format: "postgres://username:password@localhost/database"
var connectionString = process.env.DATABASE_URL;

//run the server
var port = process.env.PORT || 80; //it's required to have this environmental variable set in on deploy on heroku

var server = restify.createServer({
  name: 'lestands',
  version: '1.0.0'
});

server.pre(restify.CORS());
server.use(restify.fullResponse());
server.use(restify.acceptParser(server.acceptable));
server.use(restify.queryParser());
server.use(restify.bodyParser());


// send the database the given query and send the response to the handler
var queryDB = function (query, params, res, outputHandler) {

  if (typeof outputHandler === 'undefined') {
    outputHandler = function (rows) { return rows; };
  }

  // get a pg client from the connection pool
  pg.connect(connectionString, function (err, client, done) {

    var handleError = function (err) {
      // no error occurred, continue with the request
      if (!err) { return false; }

      // An error occurred, remove the client from the connection pool.
      // A truthy value passed to done will remove the connection from the pool
      // instead of simply returning it to be reused.
      // In this case, if we have successfully received a client (truthy)
      // then it will be removed from the pool.
      done(client);

      res.writeHead(500, {'content-type': 'text/plain'});
      res.end('An error occurred, ' + err);
      return true;
    };

    // record the visit
    client.query(query, params, function (err, result) {

      // handle an error from the query
      if (handleError(err)) { return; }

      // return the client to the connection pool for other requests to reuse
      done();

      outputHandler(result.rows);

    });
  });
};


// connects to database
// run select query on database
// send result
// before rows are sent, they're run through an optional preProcess function which by default
// does nothing. See `sendSelectionFirstRow` for example of how this could be used.
var sendSelection = function (query, params, res, preProcess) {

  if (typeof preProcess === 'undefined') {
    preProcess = function (rows) { return rows; };
  }

  var outputHandler = function (rows) {
    res.send(preProcess(rows));
  };

  queryDB(query, params, res, outputHandler);
};


// instead of sending an array of results, return just the first one.
// useful when you know there should only be one result.
var sendSelectionFirstRow = function (query, params, res) {
  var preProcess = function (rows) {
    return rows[0];
    // TODO: what to return if there is no rows[0]? (if rows.length < 1)
  };
  sendSelection(query, params, res, preProcess);
};



//Static routes:
// /stands - show all stands
// /stands/:id - show a specific stand
// /stands/:id/updates - show all updates for a specific stand
// /stands/:id/updates/:updateID - show a specific update for a specific stand


// this is just a route for the index of the API
server.get('/', function (req, res, next) {
  var bs = {
    "this": "",
    "API": "",
    "is": "",
    "just": "",
    "a": "",
    "test": ""
  };

  res.send(bs);
  return next();
});


// /stands
server.get('/stands', function (req, res, next) {

  var query = 'WITH \
    stats AS (SELECT  \
      "standID" AS id,\
      MAX(date) AS "lastUpdateDate",  \
      SUM("amountAdded") AS "totalDistributed",  \
      COUNT(id) AS "totalUpdates"  \
      FROM updates GROUP BY "standID"  \
    )\
  SELECT stands.id, stands.name, stands.description, stands."geoLat", stands."geoLong", \
         stands.address1, stands.address2, stands.city, stands.state, stands.zip, \
         stats."lastUpdateDate", COALESCE(stats."totalDistributed",0) AS "totalDistributed", COALESCE(stats."totalUpdates",0) AS "totalUpdates" \
  FROM stands LEFT OUTER JOIN stats ON stats.id = stands.id \
  ORDER BY id;';

  sendSelection(query, [], res);

  return next();
});


// /stands/:id
server.get('/stands/:standID', function (req, res, next) {

  // get updates for the given stand
  // get the given stand
  // add the updates to the stand
  // send

  var sendStand = function (updates) {

    // note this is similar to query for /stands but slightly different
    var selectStandQuery = 'WITH \
      stats AS (SELECT  \
        "standID" AS id,\
        MAX(date) AS "lastUpdateDate",  \
        SUM("amountAdded") AS "totalDistributed",  \
        COUNT(id) AS "totalUpdates"  \
        FROM updates WHERE "standID" = ($1) GROUP BY "standID" \
      )\
      SELECT stands.id, stands.name, stands.description, stands."geoLat", stands."geoLong", \
             stands.address1, stands.address2, stands.city, stands.state, stands.zip, \
             stats."lastUpdateDate", COALESCE(stats."totalDistributed",0) AS "totalDistributed", COALESCE(stats."totalUpdates",0) AS "totalUpdates" \
      FROM stands LEFT OUTER JOIN stats ON stats.id = stands.id \
      WHERE stands.id = ($1) LIMIT 1'; // note LIMIT 1 sanity check (we only expect 1 anyway)

    var preProcess = function (rows) {
      var stand = rows[0];
      stand.updates = updates;
      return stand;
    };

    sendSelection(selectStandQuery, [req.params.standID], res, preProcess);
  };

  var selectUpdatesQuery = 'SELECT * FROM updates WHERE "standID" = ($1)';
  queryDB(selectUpdatesQuery, [req.params.standID], res, sendStand);

  return next();
});


// /stands/:id/updates
// Returns an array of updates associated with a specified stand.
// If there have been no updates, the array will be empty.
server.get('/stands/:standID/updates', function (req, res, next) {

  sendSelection('SELECT * FROM updates WHERE "standID" = ($1)', [req.params.standID], res);

  return next();
});


// /stands/:id/updates/:updateID
server.get('/stands/:standID/updates/:updateID', function (req, res, next) {

  sendSelectionFirstRow('SELECT * FROM updates WHERE "standID" = ($1) AND id = ($2)', [req.params.standID, req.params.updateID], res);

  return next();
});

// POST a new update to /stands/:standID/updates
// On success, returns the ID of the new update which can later
// be fetched by a GET request to /stands/:standID/updates/:id.
// On error, returns an error string.
server.post('/stands/:standID/updates', function (req, res, next) {

  var sql = 'INSERT INTO updates ("standID", "date", "amountWhenChecked", "amountAdded", "comments") VALUES (($1), ($2), ($3), ($4), ($5))  RETURNING id;';

  var outputHandler = function (rows) {
    res.send(rows[0]);
  }

  queryDB(sql, [req.params.standID, req.body.date, req.body.amountWhenChecked, req.body.amountAdded, req.body.comments], res, outputHandler);

  return next();
});

// DELETE a specific update
server.del('/stands/:standID/updates/:updateID', function (req, res, next) {

  var sql = 'DELETE FROM updates WHERE id = ($1) RETURNING id;';

  var outputHandler = function (rows) {
    // the following commented code works as a substitute to sending 204
    // var message;
    // if (rows.length) {
    //   message = { status: "success" }
    // } else {
    //   message = { status: "failure" }
    // }
    // res.send(message);
    res.send(204);
  }

  queryDB(sql, [req.params.updateID], res, outputHandler);

  return next();
});


server.listen(port, function () {
  console.log('%s listening at url %s', server.name, server.url);
});