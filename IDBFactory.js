//
// Copyright (c) 2012, Peter Jekel
// All rights reserved.
//
//	The indexedDB implementation is released under to following two licenses:
//
//	1 - The "New" BSD License			 (http://trac.dojotoolkit.org/browser/dojo/trunk/LICENSE#L13)
//	2 - The Academic Free License	 (http://trac.dojotoolkit.org/browser/dojo/trunk/LICENSE#L43)
//
define(["dojo/Deferred",
				"./Database",
				"./dom/error/DOMException",
				"./dom/error/DOMError",
				"./dom/event/Event",
				"./IDBDatabase",
				"./IDBOpenRequest",
				"./util/Keys",
				"./util/url"
			 ], function (Deferred, Database, DOMException, DOMError, Event,
										 IDBDatabase, IDBOpenRequest,
										 Keys, url ) {
	"use strict";
	// Requires JavaScript 1.8.5
	var defineProperty = Object.defineProperty;

	function fireVersionChange(IDBFactory, /*DatabaseName*/ name, /*number*/ version) {
		// summary:
		//		Dispatch the "versionchange" event to all open connections associated
		//		with the database being opened or deleted.   When all connections are
		//		closed the promise returned is resolved.
		// version:
		//		New version of the database. (null when DB is being deleted).
		// returns:
		//		A promise
		// tag:
		//		Private
		var connections  = IDBFactory._getConnections( name );
		var closePending = [];
		var deferred     = new Deferred;
		var firedEvent   = false;

		function closedHandler( event ) {
			// summary:
			//		Connection closed event handler. Whenever a database connection is
			//		closed a 'closed' event is recieved and the associated connection
			//		is removed from the list of pending connections.
			// event:
			//		DOM style Event.
			// tag:
			//		Private
			closePending = closePending.filter(
											function( pending ) {
												if (pending.connection == this) {
													pending.evtHndl.remove();
													return false;
												}
												return true;
											}, this);
			if (closePending.length == 0) {
				deferred.resolve();
			}
		}

		if (connections.length > 0) {
			connections.forEach( function (conn) {
				var event = new Event( "versionchange", {oldVersion: conn.version, newVersion: version });
				if (conn._isOpen()) {
					var closing = { evtHndl: conn.on( "closed", closedHandler ),
													connection: conn	};
					closePending.push( closing );
					setTimeout( function() {
												conn.dispatchEvent( event );
											}, 0 );
					firedEvent = true;
				}
			});
		}
		// If no event was fired (there are no open connections) resolve the promise
		// immediately.
		if (!firedEvent) {
			deferred.resolve();
		}
		return deferred.promise;
	}

	function IDBFactory() {
		// summary:
		//		Implements the IDBFactory interface
		// tag:
		//		Public

		var factory        = this;
		var databases      = {};
		var connections    = [];

		defineProperty( this, "dojo", {value: true});
		defineProperty( this, "_getConnections", {
			value:	function (/*String*/ databaseName) {
								var dbConn = connections.filter(function(connection) {
																	return (connection.name === databaseName);
																});
								return dbConn;
							},
			enumerable: false
		});

		// For debug purpose only....
		defineProperty( this, "databases", {
			get:	function  () {return databases;},
			enumerable: true
		});

		//=========================================================================
		// Public methods

		this.cmp = function (first, second) {
			// summary:
			//		This method compares two keys. The method returns 1 if the first key
			//		is greater than the second, -1 if the first is less than the second,
			//		and 0 if the first is equal to the second.
			// first:
			//		First key to compare.
			// second:
			//		Second key to compare.
			// tag:
			//		Public
			if (Keys.isValidKey(first) && Keys.isValidKey(second)) {
				return Keys.compare( first, second );
			}
			throw new DOMException("DataError");
		};

		this.deleteDatabase = function (/*String*/ name) {
			// summary:
			// name:
			//		The name of the database.
			// tag:
			//		Public

			function _deleteDB( args, request) {
				var dbURL    = url.resolve( args.name, "http://localhost" );
				var dbName   = dbURL.replace(/\./g,"%2E" );
				var database = databases[dbName];

				if (database) {
					database.deletePending = true;
					var promise = fireVersionChange( factory, dbName, null);
					promise.then(
						function() {
							var event = new Event( "success", {oldVersion: database.version, newVersion: null });
							database.deleteDatabase();
							delete databases[dbName];

							request.result = undefined;
							request._fireSuccess(event);

							// Signal the database has been deleted.
							database.dispatchEvent( new Event("delete") );
						},
						function(err) {
							request.reject(err);
						}
					);

					setTimeout( function () {
						if (!promise.isFulfilled()) {
							var event = new Event( "blocked", { newVersion: null, oldVersion: database.version });
							request.dispatchEvent(event, request);	// Fire at the request only.
						}
					}, 500);
				} else {
					var event = new Event( "success", {oldVersion: undefined, newVersion: null });
					request.result = undefined;
					request._fireSuccess(event);
				}
			}

			if (typeof name === "string") {
				var request = new IDBOpenRequest( null, _deleteDB, {name: name} );
				return request._execute();
			} else {
				throw new Error("Parameter [name] must be a string.");
			}
		};

		this.open = function (/*String*/ name, /*Number?*/ version, /*Object*/ databaseOptions) {
			// summary:
			//		Open a database.
			// name:
			//		The name of the database.
			// version:
			//		The version of the database.
			// stores:
			// tag:
			//		Public

			function _open(args, request ) {
				// summary:
				// args:
				// request:
				// tag:
				//		Private

				function versionChange(database, dbConn, newVersion, request) {
					// summary:
					// database:
					// dbConn
					// newVersion:
					// request:
					//		A IDBOpenRequest
					// tag:
					//		Private
					var promise    = fireVersionChange( factory, dbConn.name, newVersion);
					var storeNames = dbConn.objectStoreNames;
					var oldVersion = database.version;

					database.versionChange();
					promise.then(
						function () {
							var transaction = dbConn.transaction( dbConn.objectStoreNames, IDBTransaction.VERSION_CHANGE );
							// Once the new 'versionchange' transaction has started fire the
							// upgradeneeded event.
							transaction.on( "start", function (event) {
								var event = new Event("upgradeneeded", {oldVersion: oldVersion,
																												 newVersion: newVersion});

								dbConn.version = database.setVersion( newVersion );
								request.result = dbConn;
								transaction._queue( request );
								request.dispatchEvent(event);
							});
							// Only when the versionchange transaction is complete do we mark
							// the database as ready and fire the success event at the request.
							transaction.on( "complete", function (event) {
								database.signalReady();
								request._fireSuccess(new Event("success"), [request]);
							});
							// If the versionchange transaction is aborted, set the connection
							// to its default values...
							transaction.on( "abort", function (event) {
								// TODO: rollback store and index creation...
								database.signalReady();
								dbConn.version = 0;
								dbConn.objectStoreNames = null;
							});
							// Clear the 'blocked' timer.
							clearTimeout( request._timeout );
							delete request._timeout;
						},
						function (err) {
							var error = err || new DOMError("AbortError");
							var event = new Event( "error", {error: error, bubbles: true});
							request.dispatchEvent(event);
							dbConn.close();
							// Clear the 'blocked' timer.
							clearTimeout( request._timeout );
							delete request._timeout;
						});

					// Give the open connections some time to respond before we call being
					// blocked. Note, waiting on the connections to close is called-out as
					// a potential issue in the current indexedDB standard. For additional
					// information see:
					// 	 http://www.w3.org/TR/IndexedDB/#versionchange--transaction-steps
					if (!promise.isFulfilled()) {
						request._timeout = setTimeout( function () {
							var event = new Event( "blocked", { newVersion: version, oldVersion: dbConn.version });
							request.dispatchEvent(event, [request]);	// Fire at the request only.
						}, 1000 );
					}
				} /* end fireVersionChange() */

				function connect(/*database*/ database, /*Number*/ version, /*IDBOpenRequest*/ request) {
					// summary:
					//		Create a connection. The connection is represented by an IDBDatabase
					//		object and returned as the result of the IDBOpenRequest.
					// database:
					//		Instance of a database object.
					// version:
					//		New database version.
					// request:
					//		An IDBOpenRequest
					// tag:
					//		Private
					var dbConn = new IDBDatabase( database );
					try {
						if (database.version < version) {
							versionChange( database, dbConn, version, request );
						} else {
							if (database.version > version) {
								throw new DOMException("VersionError");
							} else {
								request.result = dbConn;
								request._fireSuccess(new Event("success"), [request]);
							}
						}
						// Add an event handler so we can cleanup when the connection is closed.
						dbConn.on("closed", function() {
							var idx = connections.indexOf( this );
							if (idx != -1) {
								connections.splice(idx,1);
							}
						});
						connections.push( dbConn );
						return dbConn;
					} catch(err) {
						request.reject(err);
						dbConn.close();
					}
				} /* end connect() */

				var dbURL    = url.resolve( args.name, "http://localhost" );
				var dbName   = dbURL.replace(/\./g,"%2E" );
				var database = databases[dbName];
				var version  = args.version;
				var options  = args.options;

				if (database) {
					// Make sure there is no 'versionchange' transaction running and the
					// deletePending flag on the database isn't set.
					var vcTrans = IDBWorker.getVCTransaction( database );
					if (vcTrans || database.deletePending) {
						if (vcTrans) {
							// Wait for the version change transaction to complete...
							vcTrans.on( "done", function(event) {
								connect( database, version, request );
							});
						} else {
							// Wait for the database to be deleted....
							var handle = database.on("delete", function() {
								handle.remove();
								setTimeout( function() {
									_open( args, request );
								}, 0);
							});
						}
					} else {
						if (!database.ready) {
							// RACE CONDITION:
							//		Another connection is still in the process of initiating a
							//		version change but the associated transaction hasn't started
							//		yet, therefore we have nothing to attach an eventListener to
							//		other than the database itself. Wait for the database to get
							//		ready and retry the IDBOpenRequest.
							var handle = database.on( "ready", function(event) {
								handle.remove();
								setTimeout( function() {
									_open( args, request );
								}, 0);
							});
						} else {
							connect( database, version, request );
						}
					}
				} else {
					// It's a new database, wait for the database 'load' event before
					// connecting or, in case of an error, reject the IDBOpenRequest.
					database = new Database( dbName, options );
					database.on( "load", function (event) {
						connect( database, version, request );
					});
					database.on( "error", function (event) {
						var srcType = "", srcName = "", srcDesc = "";
						var errName, message;

						errName = event.error ? event.error.name : "UnknownError";
						if (event.source) {
							srcType = event.source._isStore ? "Store" : (event.source._isIndex ? "Index" : "Database")
							srcName = event.source.name;
							srcDesc = srcType + " [" + srcName + "] ";
						}
						// Compose the message and stick it as a DOMError on the request.
						message = srcDesc + "error: {" + event.error + "}, status code: " + event.status;
						request.reject( new DOMError( event.error.name, message ));
					});
					databases[dbName] = database;
				}
			} /* end _open() */

			//===============================

			if (typeof name === "string") {
				version = version || 1;
				if (arguments.length > 1) {
					if (arguments[1] && typeof arguments[1] === "number") {
						version = arguments[1];
					} else {
						databaseOptions = arguments[1];
						version = 1;
					}
					if (databaseOptions && typeof databaseOptions !== "object") {
						throw new TypeError("Parameter [stores] requires an objects.");
					}
				}

				// Compose a new IDBOpenRequest. Because the request is not under the
				// control of a transaction excute the request directly.
				var request = new IDBOpenRequest( null, _open, {name: name, version: version, options: databaseOptions} );
				return request._execute();
			} else {
				throw new TypeError("Parameter [name] requires a string.");
			}
		};	/* end open() */

	}	/* end IDBFactory() */

	return IDBFactory;
});
