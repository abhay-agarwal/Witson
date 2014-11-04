/*jshint node:true*/

// app.js
// This file contains the server side JavaScript code for your application.
// This sample application uses express as web application framework (http://expressjs.com/),
// and jade as template engine (http://jade-lang.com/).

var express = require('express');
var request = require('request');
var async = require('async');
var https = require('https');
var url = require('url');
var querystring = require('querystring');
var extend = require('util')._extend;

var dummy_text = require('./dummy-text').text;
var flatten = require('./flatten');

//WIT
var wit = require('node-wit');
var fs = require('fs');
var ACCESS_TOKEN = 'M4V2WXONEJOVMKMT57NDSIBKBTA46RGK';

// setup middleware
var app = express();
app.use(express.errorHandler());
app.use(express.urlencoded()); // to support URL-encoded bodies
app.use(app.router);

app.use(express.static(__dirname + '/public')); //setup static public directory
app.set('view engine', 'jade');
app.set('views', __dirname + '/views'); //optional since express defaults to CWD/views

// There are many useful environment variables available in process.env
// VCAP_APPLICATION contains useful information about a deployed application.
var appInfo = JSON.parse(process.env.VCAP_APPLICATION || "{}");
// TODO: Get application information and use it in your app.

// There are many useful environment variables available in process.env.
// VCAP_APPLICATION contains useful information about a deployed application.
var appInfo = JSON.parse(process.env.VCAP_APPLICATION || "{}");
// TODO: Get application information and use it in your app.

// VCAP_SERVICES contains all the credentials of services bound to
// this application. For details of its content, please refer to
// the document or sample of each service.
// If VCAP_SERVICES is undefined we use a local module as mockup

// defaults for dev outside bluemix
var service_url = '<service_url>';
var service_username = '<service_username>';
var service_password = '<service_password>';

if (process.env.VCAP_SERVICES) {
	console.log('Parsing VCAP_SERVICES');
	var services = JSON.parse(process.env.VCAP_SERVICES);
	//service name, check the VCAP_SERVICES in bluemix to get the name of the services you have
	var service_name = 'user_modeling';
	
	if (services[service_name]) {
		var svc = services[service_name][0].credentials;
		service_url = svc.url;
		service_username = svc.username;
		service_password = svc.password;
	} else {
		console.log('The service '+service_name+' is not in the VCAP_SERVICES, did you forget to bind it?');
	}

} else {
	console.log('No VCAP_SERVICES found in ENV, using defaults for local development');
}

console.log('service_url = ' + service_url);
console.log('service_username = ' + service_username);
console.log('service_password = ' + new Array(service_password.length).join("X"));

var auth = 'Basic ' + new Buffer(service_username + ':' + service_password).toString('base64');

// render index page
app.get('/', function(req, res) {
	res.render('index', {'content': ''});
});

//submit witson form
app.post('/', function(req, res){

	// See User Modeling API docs. Path to profile analysis is /api/v2/profile
	// remove the last / from service_url if exist
	var parts = url.parse(service_url.replace(/\/$/,''));

	var profile_options = { host: parts.hostname,
		port: parts.port,
		path: parts.pathname + "/api/v2/profile",
		method: 'POST',
		headers: {
			'Content-Type'  :'application/json',
			'Authorization' :  auth 
		}
	};

	var wit_key = req.body.apikey.trim() || ACCESS_TOKEN;
	var test_command = req.body.content.trim();
	if (!test_command) return res.render('index', {'error': 'You forgot to enter a command'});

	//asynchronously execute these actions in series:
	async.waterfall([
		function (callback) { //grab max 10 intents from the user (to minimize API calls)
			var getIntents = {
				url: 'https://api.wit.ai/intents?v=20141022',
				json: 'true',
				headers: {
					'Authorization': 'Bearer ' + wit_key
				}
			};
			request(getIntents, function (err, res, body) {
				if (body && body.length) return callback(null, body.slice(0,10));
				
				return callback(err || {message: 'Your API has no training data'});
			});
		},
		function (intents, callback) { //grab max 25 of each intent's expressions

			async.concat(intents, function (intent, expanded) {
				var getExpressions = {
					url: 'https://api.wit.ai/intents/'+intent.name+'?v=20141022',
					json: 'true',
					headers: {
						'Authorization': 'Bearer ' + wit_key
					}
				};
				request(getExpressions, function (err, res, body) {
					if (body) return expanded(null, body.expressions || {});
					
					return expanded(err || {message: 'Error in intent '+intent.name});
				});
			}, function (err, expressions) {
				if (err) return callback(err);
				if (!expressions || !expressions.length) 
					return callback({message: 'Your API has no registered expressions'});

				return callback(err, expressions.slice(0,40));
			});
		},
		function (expressions, callback) { //concatenate the bodies of the expressions
			async.reduce(expressions, "", function (content, expression, callback) {
				callback(null, content + expression.body + " ");
			}, function (err, trainingData) {
				return callback(err, trainingData);
			});
		},
		function (trainingData, callback) { //make the two magic calls
			var metadata = {};
			async.parallel([
				function (done) { //make a call to Wit with our current command
					wit.captureTextIntent(wit_key, req.body.content, function (err, res) {
						if (err) return done(err);
						metadata.wit = res;
						return done(null);
					});
				},
				function (done) { //make a call to IBM with wit's expression blob
					var toAnalyze = trainingData + " " + req.body.content;
					// create a profile request with the text and the htpps options and call it
					create_profile_request(profile_options,toAnalyze)(function(error,profile_string) {
						if (error) return done(error);
						
						// parse the profile and format it
						var profile_json = JSON.parse(profile_string);

						var sortingFunction = function (a, b) {
							return b.intensity - a.intensity;
						};
						metadata.attributes = flatten.flat(profile_json.tree).sort(sortingFunction);

						// Extend the profile options and change the request path to get the visualization
						// Path to visualization is /api/v2/visualize, add w and h to get 900x900 chart
						var viz_options = extend(profile_options, { path :  parts.pathname + 
							"/api/v2/visualize?w=900&h=900&imgurl=%2Fimages%2Fapp.png"});

						// create a visualization request with the profile data
						create_viz_request(viz_options,profile_string)(function(error,viz) {
							if (error) return done(error);
							metadata.viz = viz;
							return done(null);
						});
					});
				}
			], function (err) {
				if (err) return callback(err);

				metadata.wit.dominant_emotions = metadata.attributes.slice(0,5);

				return callback(null, {
					'apikey':req.body.apikey, 
					'content': req.body.content,
					'result': JSON.stringify(metadata.wit, null, 2),
					'viz': metadata.viz
				});
			});
		}
	], function (err, toRender) {
		if (err) return res.render('index', {'error': err.message});
		else return res.render('index', toRender);
	});
});

// creates a request function using the https options and the text in content
// the function that return receives a callback
var create_profile_request = function(options,content) {
	return function (/*function*/ callback) {
	 // create the post data to send to the User Modeling service
	 var post_data = {
		'contentItems' : [{ 
			'userid' : 'dummy',
			'id' : 'dummyUuid',
			'sourceid' : 'freetext',
			'contenttype' : 'text/plain',
			'language' : 'en',
			'content': content
		}]
	 };
	 // Create a request to POST to the User Modeling service
	 var profile_req = https.request(options, function(result) {
		result.setEncoding('utf-8');
		var response_string = '';

		result.on('data', function(chunk) {
			response_string += chunk;
		});
		
		result.on('end', function() {

			if (result.statusCode != 200) {
				var error = JSON.parse(response_string);
				callback({'message': error.user_message}, null);
			} else
			callback(null,response_string);
		});
	 });
	 
	 profile_req.on('error', function(e) {
		callback(e,null);
	 });

	 profile_req.write(JSON.stringify(post_data));
	 profile_req.end();
	};
};

// creates a request function using the https options and the profile 
// the function that return receives a callback
var create_viz_request = function(options,profile) {
	return function (/*function*/ callback) {
	 // Create a request to POST to the User Modeling service
	 var viz_req = https.request(options, function(result) {
		result.setEncoding('utf-8');
		var response_string = '';

		result.on('data', function(chunk) {
			response_string += chunk;
		});
		
		result.on('end', function() {
			if (result.statusCode != 200) {
				var error = JSON.parse(response_string);
				callback({'message': error.user_message}, null);
			} else
			callback(null,response_string);      });
	 });
	 
	 viz_req.on('error', function(e) {
		callback(e,null);
	 });
	 viz_req.write(profile);
	 viz_req.end();
	};
};

// The IP address of the Cloud Foundry DEA (Droplet Execution Agent) that hosts this application:
var host = (process.env.VCAP_APP_HOST || 'localhost');
// The port on the DEA for communication with the application:
var port = (process.env.VCAP_APP_PORT || 3000);
// Start server
app.listen(port, host);