/**
 * The MessageHandler handles all Messages that comes from Socket.IO and controls the sessions 
 */ 

/*
 * Copyright 2009 Google Inc., 2011 Peter 'Pita' Martischka (Primary Technology Ltd)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */


var ERR = require("async-stacktrace");
var async = require("async");
var padManager = require("../db/PadManager");
var Changeset = require("ep_etherpad-lite/static/js/Changeset");
var AttributePool = require("ep_etherpad-lite/static/js/AttributePool");
var AttributeManager = require("ep_etherpad-lite/static/js/AttributeManager");
var authorManager = require("../db/AuthorManager");
var readOnlyManager = require("../db/ReadOnlyManager");
var settings = require('../utils/Settings');
var securityManager = require("../db/SecurityManager");
var plugins = require("ep_etherpad-lite/static/js/pluginfw/plugins.js");
var log4js = require('log4js');
var messageLogger = log4js.getLogger("message");
var accessLogger = log4js.getLogger("access");
var _ = require('underscore');
var hooks = require("ep_etherpad-lite/static/js/pluginfw/hooks.js");

/**
 * A associative array that saves informations about a session
 * key = sessionId
 * values = padId, readonlyPadId, readonly, author, rev
 *   padId = the real padId of the pad
 *   readonlyPadId = The readonly pad id of the pad
 *   readonly = Wether the client has only read access (true) or read/write access (false)
 *   rev = That last revision that was send to this client
 *   author = the author name of this session
 */
var sessioninfos = {};

/**
 * Saves the Socket class we need to send and recieve data from the client
 */
var socketio;

/**
 * This Method is called by server.js to tell the message handler on which socket it should send
 * @param socket_io The Socket
 */
exports.setSocketIO = function(socket_io)
{
  socketio=socket_io;
}

/**
 * Handles the connection of a new user
 * @param client the new client
 */
exports.handleConnect = function(client)
{  
  //Initalize sessioninfos for this new session
  sessioninfos[client.id]={};
}

/**
 * Kicks all sessions from a pad
 * @param client the new client
 */
exports.kickSessionsFromPad = function(padID)
{
  //skip if there is nobody on this pad
  if(socketio.sockets.clients(padID).length == 0)
    return;

  //disconnect everyone from this pad
  socketio.sockets.in(padID).json.send({disconnect:"deleted"});
}

/**
 * Handles the disconnection of a user
 * @param client the client that leaves
 */
exports.handleDisconnect = function(client)
{  
  //save the padname of this session
  var session = sessioninfos[client.id];
  
  //if this connection was already etablished with a handshake, send a disconnect message to the others
  if(session && session.author)
  {
    //get the author color out of the db
    authorManager.getAuthorColorId(session.author, function(err, color)
    {
      ERR(err);
      
      //prepare the notification for the other users on the pad, that this user left
      var messageToTheOtherUsers = {
        "type": "COLLABROOM",
        "data": {
          type: "USER_LEAVE",
          userInfo: {
            "ip": "127.0.0.1",
            "colorId": color,
            "userAgent": "Anonymous",
            "userId": session.author
          }
        }
      };
      
      //Go trough all user that are still on the pad, and send them the USER_LEAVE message
      client.broadcast.to(session.padId).json.send(messageToTheOtherUsers);
    }); 
  }
  
  client.get('remoteAddress', function(er, ip) {
    accessLogger.info('[LEAVE] Pad "'+session.padId+'": Author "'+session.author+'" on client '+client.id+' with IP "'+ip+'" left the pad')
  })
  
  //Delete the sessioninfos entrys of this session
  delete sessioninfos[client.id]; 
}

/**
 * Handles a message from a user
 * @param client the client that send this message
 * @param message the message from the client
 */
exports.handleMessage = function(client, message)
{ 

  if(message == null)
  {
    messageLogger.warn("Message is null!");
    return;
  }
  if(!message.type)
  {
    messageLogger.warn("Message has no type attribute!");
    return;
  }

  var handleMessageHook = function(callback){
    var dropMessage = false;
    
    // Call handleMessage hook. If a plugin returns null, the message will be dropped. Note that for all messages 
    // handleMessage will be called, even if the client is not authorized
    hooks.aCallAll("handleMessage", { client: client, message: message }, function ( err, messages ) {
      if(ERR(err, callback)) return;
      
      _.each(messages, function(newMessage){
        if ( newMessage === null ) {
          dropMessage = true;
        }
      });
      
      // If no plugins explicitly told us to drop the message, its ok to proceed
      if(!dropMessage){ callback() };
    });
  }

  var finalHandler = function () {
    //Check what type of message we get and delegate to the other methodes
    if(message.type == "CLIENT_READY") {
      handleClientReady(client, message);
    } else if(message.type == "CHANGESET_REQ") {
      handleChangesetRequest(client, message);
    } else if(message.type == "COLLABROOM") {
      if (sessioninfos[client.id].readonly) {
        messageLogger.warn("Dropped message, COLLABROOM for readonly pad");
      } else if (message.data.type == "USER_CHANGES") {
        handleUserChanges(client, message);
      } else if (message.data.type == "USERINFO_UPDATE") {
        handleUserInfoUpdate(client, message);
      } else if (message.data.type == "CHAT_MESSAGE") {
        handleChatMessage(client, message);
      } else if (message.data.type == "GET_CHAT_MESSAGES") {
        handleGetChatMessages(client, message);
      } else if (message.data.type == "SAVE_REVISION") {
        handleSaveRevisionMessage(client, message);
      } else if (message.data.type == "CLIENT_MESSAGE" &&
                 message.data.payload != null &&
                 message.data.payload.type == "suggestUserName") {
        handleSuggestUserName(client, message);
      } else {
        messageLogger.warn("Dropped message, unknown COLLABROOM Data  Type " + message.data.type);
      }
    } else {
      messageLogger.warn("Dropped message, unknown Message Type " + message.type);
    }
  };

  if (message) {
    async.series([
      handleMessageHook,
      //check permissions
      function(callback)
      {
        
        // If the message has a padId we assume the client is already known to the server and needs no re-authorization
        if(!message.padId)
          return callback();

        // Note: message.sessionID is an entirely different kind of
        // session from the sessions we use here! Beware! FIXME: Call
        // our "sessions" "connections".
        // FIXME: Use a hook instead
        // FIXME: Allow to override readwrite access with readonly
        securityManager.checkAccess(message.padId, message.sessionID, message.token, message.password, function(err, statusObject)
        {
          if(ERR(err, callback)) return;

          //access was granted
          if(statusObject.accessStatus == "grant")
          {
            callback();
          }
          //no access, send the client a message that tell him why
          else
          {
            client.json.send({accessStatus: statusObject.accessStatus})
          }
        });
      },
      finalHandler
    ]);
  }
}


/**
 * Handles a save revision message
 * @param client the client that send this message
 * @param message the message from the client
 */
function handleSaveRevisionMessage(client, message){
  var padId = sessioninfos[client.id].padId;
  var userId = sessioninfos[client.id].author;
  
  padManager.getPad(padId, function(err, pad)
  {
    if(ERR(err)) return;
    
    pad.addSavedRevision(pad.head, userId);
  });
}

/**
 * Handles a custom message (sent via HTTP API request)
 *
 * @param padID {Pad} the pad to which we're sending this message
 * @param msg {String} the message we're sending
 */
exports.handleCustomMessage = function (padID, msg, cb) {
  var time = new Date().getTime();
  var msg = {
    type: 'COLLABROOM',
    data: {
      type: msg,
      time: time
    }
  };
  socketio.sockets.in(padID).json.send(msg);

  cb(null, {});
}

/**
 * Handles a Chat Message
 * @param client the client that send this message
 * @param message the message from the client
 */
function handleChatMessage(client, message)
{
  var time = new Date().getTime();
  var userId = sessioninfos[client.id].author;
  var text = message.data.text;
  var padId = sessioninfos[client.id].padId;
  
  var pad;
  var userName;
  
  async.series([
    //get the pad
    function(callback)
    {
      padManager.getPad(padId, function(err, _pad)
      {
        if(ERR(err, callback)) return;
        pad = _pad;
        callback();
      });
    },
    function(callback)
    {
      authorManager.getAuthorName(userId, function(err, _userName)
      {
        if(ERR(err, callback)) return;
        userName = _userName;
        callback();
      });
    },
    //save the chat message and broadcast it
    function(callback)
    {
      //save the chat message
      pad.appendChatMessage(text, userId, time);
      
      var msg = {
        type: "COLLABROOM",
        data: {
                type: "CHAT_MESSAGE",
                userId: userId,
                userName: userName,
                time: time,
                text: text
              }
      };
      
      //broadcast the chat message to everyone on the pad
      socketio.sockets.in(padId).json.send(msg);
      
      callback();
    }
  ], function(err)
  {
    ERR(err);
  });
}

/**
 * Handles the clients request for more chat-messages
 * @param client the client that send this message
 * @param message the message from the client
 */
function handleGetChatMessages(client, message)
{
  if(message.data.start == null)
  {
    messageLogger.warn("Dropped message, GetChatMessages Message has no start!");
    return;
  }
  if(message.data.end == null)
  {
    messageLogger.warn("Dropped message, GetChatMessages Message has no start!");
    return;
  }
  
  var start = message.data.start;
  var end = message.data.end;
  var count = start - count;
  
  if(count < 0 && count > 100)
  {
    messageLogger.warn("Dropped message, GetChatMessages Message, client requested invalid amout of messages!");
    return;
  }
  
  var padId = sessioninfos[client.id].padId;
  var pad;
  
  async.series([
    //get the pad
    function(callback)
    {
      padManager.getPad(padId, function(err, _pad)
      {
        if(ERR(err, callback)) return;
        pad = _pad;
        callback();
      });
    },
    function(callback)
    {
      pad.getChatMessages(start, end, function(err, chatMessages)
      {
        if(ERR(err, callback)) return;
		
        var infoMsg = {
          type: "COLLABROOM",
          data: {
            type: "CHAT_MESSAGES",
            messages: chatMessages
          }
        };
		
        // send the messages back to the client
        client.json.send(infoMsg);
      });
    }]);
}

/**
 * Handles a handleSuggestUserName, that means a user have suggest a userName for a other user
 * @param client the client that send this message
 * @param message the message from the client
 */
function handleSuggestUserName(client, message)
{
  //check if all ok
  if(message.data.payload.newName == null)
  {
    messageLogger.warn("Dropped message, suggestUserName Message has no newName!");
    return;
  }
  if(message.data.payload.unnamedId == null)
  {
    messageLogger.warn("Dropped message, suggestUserName Message has no unnamedId!");
    return;
  }
  
  var padId = sessioninfos[client.id].padId,
      clients = socketio.sockets.clients(padId);
  
  //search the author and send him this message
  for(var i = 0; i < clients.length; i++) {
    var session = sessioninfos[clients[i].id];
    if(session && session.author == message.data.payload.unnamedId) {
      clients[i].json.send(message);
      break;
    }
  }
}

/**
 * Handles a USERINFO_UPDATE, that means that a user have changed his color or name. Anyway, we get both informations
 * @param client the client that send this message
 * @param message the message from the client
 */
function handleUserInfoUpdate(client, message)
{
  //check if all ok
  if(message.data.userInfo == null)
  {
    messageLogger.warn("Dropped message, USERINFO_UPDATE Message has no userInfo!");
    return;
  }
  if(message.data.userInfo.colorId == null)
  {
    messageLogger.warn("Dropped message, USERINFO_UPDATE Message has no colorId!");
    return;
  }
  
  //Find out the author name of this session
  var author = sessioninfos[client.id].author;
  
  //Tell the authorManager about the new attributes
  authorManager.setAuthorColorId(author, message.data.userInfo.colorId);
  authorManager.setAuthorName(author, message.data.userInfo.name);
  
  var padId = sessioninfos[client.id].padId;

  var infoMsg = {
    type: "COLLABROOM",
    data: {
      // The Client doesn't know about USERINFO_UPDATE, use USER_NEWINFO
      type: "USER_NEWINFO",
      userInfo: {
        userId: author,
        //set a null name, when there is no name set. cause the client wants it null
        name: message.data.userInfo.name || null,
        colorId: message.data.userInfo.colorId,
        userAgent: "Anonymous",
        ip: "127.0.0.1",
      }
    }
  };
  
  //Send the other clients on the pad the update message
  client.broadcast.to(padId).json.send(infoMsg);
}

/**
 * Handles a USER_CHANGES message, where the client submits its local
 * edits as a changeset.
 *
 * This handler's job is to update the incoming changeset so that it applies
 * to the latest revision, then add it to the pad, broadcast the changes
 * to all other clients, and send a confirmation to the submitting client.
 *
 * This function is based on a similar one in the original Etherpad.
 *   See https://github.com/ether/pad/blob/master/etherpad/src/etherpad/collab/collab_server.js in the function applyUserChanges()
 *
 * @param client the client that send this message
 * @param message the message from the client
 */
function handleUserChanges(client, message)
{
  // Make sure all required fields are present
  if(message.data.baseRev == null)
  {
    messageLogger.warn("Dropped message, USER_CHANGES Message has no baseRev!");
    return;
  }
  if(message.data.apool == null)
  {
    messageLogger.warn("Dropped message, USER_CHANGES Message has no apool!");
    return;
  }
  if(message.data.changeset == null)
  {
    messageLogger.warn("Dropped message, USER_CHANGES Message has no changeset!");
    return;
  }
 
  //get all Vars we need
  var baseRev = message.data.baseRev;
  var wireApool = (new AttributePool()).fromJsonable(message.data.apool);
  var changeset = message.data.changeset;
  // The client might disconnect between our callbacks. We should still
  // finish processing the changeset, so keep a reference to the session.
  var thisSession = sessioninfos[client.id];
      
  var r, apool, pad;
    
  async.series([
    //get the pad
    function(callback)
    {
      padManager.getPad(thisSession.padId, function(err, value)
      {
        if(ERR(err, callback)) return;
        pad = value;
        callback();
      });
    },
    //create the changeset
    function(callback)
    {
      //ex. _checkChangesetAndPool
  
      try
      {
        // Verify that the changeset has valid syntax and is in canonical form
        Changeset.checkRep(changeset);

        // Verify that the attribute indexes used in the changeset are all
        // defined in the accompanying attribute pool.
        Changeset.eachAttribNumber(changeset, function(n) {
          if (! wireApool.getAttrib(n)) {
            throw "Attribute pool is missing attribute "+n+" for changeset "+changeset;
          }
        });
      }
      catch(e)
      {
        // There is an error in this changeset, so just refuse it
        console.warn("Can't apply USER_CHANGES "+changeset+", because it failed checkRep");
        client.json.send({disconnect:"badChangeset"});
        return;
      }
        
      //ex. adoptChangesetAttribs
        
      //Afaik, it copies the new attributes from the changeset, to the global Attribute Pool
      changeset = Changeset.moveOpsToNewPool(changeset, wireApool, pad.pool);
        
      //ex. applyUserChanges
      apool = pad.pool;
      r = baseRev;

      // The client's changeset might not be based on the latest revision,
      // since other clients are sending changes at the same time.
      // Update the changeset so that it can be applied to the latest revision.
      //https://github.com/caolan/async#whilst
      async.whilst(
        function() { return r < pad.getHeadRevisionNumber(); },
        function(callback)
        {
          r++;
            
          pad.getRevisionChangeset(r, function(err, c)
          {
            if(ERR(err, callback)) return;

            // At this point, both "c" (from the pad) and "changeset" (from the
            // client) are relative to revision r - 1. The follow function
            // rebases "changeset" so that it is relative to revision r
            // and can be applied after "c".
            changeset = Changeset.follow(c, changeset, false, apool);

            if ((r - baseRev) % 200 == 0) { // don't let the stack get too deep
              async.nextTick(callback);
            } else {
              callback(null);
            }
          });
        },
        //use the callback of the series function
        callback
      );
    },
    //do correction changesets, and send it to all users
    function (callback)
    {
      var prevText = pad.text();
      
      if (Changeset.oldLen(changeset) != prevText.length) 
      {
        console.warn("Can't apply USER_CHANGES "+changeset+" with oldLen " + Changeset.oldLen(changeset) + " to document of length " + prevText.length);
        client.json.send({disconnect:"badChangeset"});
        callback();
        return;
      }
        
      pad.appendRevision(changeset, thisSession.author);
        
      var correctionChangeset = _correctMarkersInPad(pad.atext, pad.pool);
      if (correctionChangeset) {
        pad.appendRevision(correctionChangeset);
      }

      // Make sure the pad always ends with an empty line.
      if (pad.text().lastIndexOf("\n\n") != pad.text().length-2) {
        var nlChangeset = Changeset.makeSplice(pad.text(), pad.text().length-1, 0, "\n");
        pad.appendRevision(nlChangeset);
      }
        
      exports.updatePadClients(pad, callback);
    }
  ], function(err)
  {
    ERR(err);
  });
}

exports.updatePadClients = function(pad, callback)
{       
  //skip this step if noone is on this pad
  var roomClients = socketio.sockets.clients(pad.id);
  if(roomClients.length==0)
    return callback();
  
  // since all clients usually get the same set of changesets, store them in local cache
  // to remove unnecessary roundtrip to the datalayer
  // TODO: in REAL world, if we're working without datalayer cache, all requests to revisions will be fired
  // BEFORE first result will be landed to our cache object. The solution is to replace parallel processing 
  // via async.forEach with sequential for() loop. There is no real benefits of running this in parallel,
  // but benefit of reusing cached revision object is HUGE
  var revCache = {};

  //go trough all sessions on this pad
  async.forEach(roomClients, function(client, callback)
  {
    var sid = client.id;

    //https://github.com/caolan/async#whilst
    //send them all new changesets
    async.whilst(
      function (){ return sessioninfos[sid] && sessioninfos[sid].rev < pad.getHeadRevisionNumber()},
      function(callback)
      {      
        var r = sessioninfos[sid].rev + 1;

        async.waterfall([
          function(callback) {
            if(revCache[r])
              callback(null, revCache[r]);
            else
              pad.getRevision(r, callback);
          }, 
          function(revision, callback)
          {
            revCache[r] = revision;

            var author = revision.meta.author,
                revChangeset = revision.changeset,
                currentTime = revision.meta.timestamp;

            // next if session has not been deleted
            if(sessioninfos[sid] == null)
              return callback(null);

            if(author == sessioninfos[sid].author)
            {
              client.json.send({"type":"COLLABROOM","data":{type:"ACCEPT_COMMIT", newRev:r}});
            }
            else
            {
              var forWire = Changeset.prepareForWire(revChangeset, pad.pool);
              var wireMsg = {"type":"COLLABROOM",
                             "data":{type:"NEW_CHANGES",
                                     newRev:r,
                                     changeset: forWire.translated,
                                     apool: forWire.pool,
                                     author: author,
                                     currentTime: currentTime,
                                     timeDelta: currentTime - sessioninfos[sid].time
                                    }};        
                           
              client.json.send(wireMsg);
            }

            sessioninfos[sid].time = currentTime;
            sessioninfos[sid].rev = r;

            callback(null);
          }
        ], callback);
      },
      callback
    );
  },callback);  
}

/**
 * Copied from the Etherpad Source Code. Don't know what this methode does excatly...
 */
function _correctMarkersInPad(atext, apool) {
  var text = atext.text;

  // collect char positions of line markers (e.g. bullets) in new atext
  // that aren't at the start of a line
  var badMarkers = [];
  var iter = Changeset.opIterator(atext.attribs);
  var offset = 0;
  while (iter.hasNext()) {
    var op = iter.next();
    
    var hasMarker = _.find(AttributeManager.lineAttributes, function(attribute){
      return Changeset.opAttributeValue(op, attribute, apool);
    }) !== undefined;
    
    if (hasMarker) {
      for(var i=0;i<op.chars;i++) {
        if (offset > 0 && text.charAt(offset-1) != '\n') {
          badMarkers.push(offset);
        }
        offset++;
      }
    }
    else {
      offset += op.chars;
    }
  }

  if (badMarkers.length == 0) {
    return null;
  }

  // create changeset that removes these bad markers
  offset = 0;
  var builder = Changeset.builder(text.length);
  badMarkers.forEach(function(pos) {
    builder.keepText(text.substring(offset, pos));
    builder.remove(1);
    offset = pos+1;
  });
  return builder.toString();
}

/**
 * Handles a CLIENT_READY. A CLIENT_READY is the first message from the client to the server. The Client sends his token 
 * and the pad it wants to enter. The Server answers with the inital values (clientVars) of the pad
 * @param client the client that send this message
 * @param message the message from the client
 */
function handleClientReady(client, message)
{
  //check if all ok
  if(!message.token)
  {
    messageLogger.warn("Dropped message, CLIENT_READY Message has no token!");
    return;
  }
  if(!message.padId)
  {
    messageLogger.warn("Dropped message, CLIENT_READY Message has no padId!");
    return;
  }
  if(!message.protocolVersion)
  {
    messageLogger.warn("Dropped message, CLIENT_READY Message has no protocolVersion!");
    return;
  }
  if(message.protocolVersion != 2)
  {
    messageLogger.warn("Dropped message, CLIENT_READY Message has a unknown protocolVersion '" + message.protocolVersion + "'!");
    return;
  }

  var author;
  var authorName;
  var authorColorId;
  var pad;
  var historicalAuthorData = {};
  var currentTime;
  var padIds;

  async.series([
    //Get ro/rw id:s
    function (callback)
    {
      readOnlyManager.getIds(message.padId, function(err, value) {
        if(ERR(err, callback)) return;
        padIds = value;
        callback();
      });
    },
    //check permissions
    function(callback)
    {
      // Note: message.sessionID is an entierly different kind of
      // session from the sessions we use here! Beware! FIXME: Call
      // our "sessions" "connections".
      // FIXME: Use a hook instead
      // FIXME: Allow to override readwrite access with readonly
      securityManager.checkAccess (padIds.padId, message.sessionID, message.token, message.password, function(err, statusObject)
      {
        if(ERR(err, callback)) return;
        
        //access was granted
        if(statusObject.accessStatus == "grant")
        {
          author = statusObject.authorID;
          callback();
        }
        //no access, send the client a message that tell him why
        else
        {
          client.json.send({accessStatus: statusObject.accessStatus})
        }
      });
    }, 
    //get all authordata of this new user, and load the pad-object from the database
    function(callback)
    {
      async.parallel([
        //get colorId and name
        function(callback)
        {
          authorManager.getAuthor(author, function(err, value)
          {
            if(ERR(err, callback)) return;
            authorColorId = value.colorId;
            authorName = value.name;
            callback();
          });
        },
        //get pad
        function(callback)
        {
          padManager.getPad(padIds.padId, function(err, value)
          {
            if(ERR(err, callback)) return;
            pad = value;
            callback();
          });
        }
      ], callback);
    },
    //these db requests all need the pad object (timestamp of latest revission, author data)
    function(callback)
    {
      var authors = pad.getAllAuthors();
      
      async.parallel([
        //get timestamp of latest revission needed for timeslider
        function(callback)
        {
          pad.getRevisionDate(pad.getHeadRevisionNumber(), function(err, date)
          {
            if(ERR(err, callback)) return;
            currentTime = date;
            callback();
          });
        },
        //get all author data out of the database
        function(callback)
        {
          async.forEach(authors, function(authorId, callback)
          {
            authorManager.getAuthor(authorId, function(err, author)
            {
              if(ERR(err, callback)) return;
              delete author.timestamp;
              historicalAuthorData[authorId] = author;
              callback();
            });
          }, callback);
        }
      ], callback);
      
    },
    //glue the clientVars together, send them and tell the other clients that a new one is there
    function(callback)
    {
      //Check that the client is still here. It might have disconnected between callbacks.
      if(sessioninfos[client.id] === undefined)
        return callback();

      //Check if this author is already on the pad, if yes, kick the other sessions!
      var roomClients = socketio.sockets.clients(padIds.padId);
      for(var i = 0; i < roomClients.length; i++) {
        var sinfo = sessioninfos[roomClients[i].id];
        if(sinfo && sinfo.author == author) {
          // fix user's counter, works on page refresh or if user closes browser window and then rejoins
          sessioninfos[roomClients[i].id] = {};
          roomClients[i].leave(padIds.padId);
          roomClients[i].json.send({disconnect:"userdup"});
        }
      }
      
      //Save in sessioninfos that this session belonges to this pad
      sessioninfos[client.id].padId = padIds.padId;
      sessioninfos[client.id].readOnlyPadId = padIds.readOnlyPadId;
      sessioninfos[client.id].readonly = padIds.readonly;
      
      //Log creation/(re-)entering of a pad
      client.get('remoteAddress', function(er, ip) {
        if(pad.head > 0) {
          accessLogger.info('[ENTER] Pad "'+padIds.padId+'": Client '+client.id+' with IP "'+ip+'" entered the pad');
        }
        else if(pad.head == 0) {
          accessLogger.info('[CREATE] Pad "'+padIds.padId+'": Client '+client.id+' with IP "'+ip+'" created the pad');
        }
      })

      //If this is a reconnect, we don't have to send the client the ClientVars again
      if(message.reconnect == true)
      {
        //Save the revision in sessioninfos, we take the revision from the info the client send to us
        sessioninfos[client.id].rev = message.client_rev;
      }
      //This is a normal first connect
      else
      {
        //prepare all values for the wire
        var atext = Changeset.cloneAText(pad.atext);
        var attribsForWire = Changeset.prepareForWire(atext.attribs, pad.pool);
        var apool = attribsForWire.pool.toJsonable();
        atext.attribs = attribsForWire.translated;
        
        // Warning: never ever send padIds.padId to the client. If the
        // client is read only you would open a security hole 1 swedish
        // mile wide...
        var clientVars = {
          "accountPrivs": {
              "maxRevisions": 100
          },
          "initialRevisionList": [],
          "initialOptions": {
              "guestPolicy": "deny"
          },
          "savedRevisions": pad.getSavedRevisions(),
          "collab_client_vars": {
              "initialAttributedText": atext,
              "clientIp": "127.0.0.1",
              "padId": message.padId,
              "historicalAuthorData": historicalAuthorData,
              "apool": apool,
              "rev": pad.getHeadRevisionNumber(),
              "globalPadId": message.padId,
              "time": currentTime,
          },
          "colorPalette": authorManager.getColorPalette(),
          "clientIp": "127.0.0.1",
          "userIsGuest": true,
          "userColor": authorColorId,
          "padId": message.padId,
          "initialTitle": "Pad: " + message.padId,
          "opts": {},
          // tell the client the number of the latest chat-message, which will be 
          // used to request the latest 100 chat-messages later (GET_CHAT_MESSAGES)
          "chatHead": pad.chatHead,
          "numConnectedUsers": roomClients.length,
          "readOnlyId": padIds.readOnlyPadId,
          "readonly": padIds.readonly,
          "serverTimestamp": new Date().getTime(),
          "globalPadId": message.padId,
          "userId": author,
          "abiwordAvailable": settings.abiwordAvailable(), 
          "plugins": {
            "plugins": plugins.plugins,
            "parts": plugins.parts,
          },
          "initialChangesets": [] // FIXME: REMOVE THIS SHIT
        }

        //Add a username to the clientVars if one avaiable
        if(authorName != null)
        {
          clientVars.userName = authorName;
        }
        
        //call the clientVars-hook so plugins can modify them before they get sent to the client
        hooks.aCallAll("clientVars", { clientVars: clientVars, pad: pad }, function ( err, messages ) {
          if(ERR(err, callback)) return;
          
          _.each(messages, function(newVars) {
            //combine our old object with the new attributes from the hook
            for(var attr in newVars) {
              clientVars[attr] = newVars[attr];
            }
          });
        
          //Join the pad and start receiving updates
          client.join(padIds.padId);
          //Send the clientVars to the Client
          client.json.send({type: "CLIENT_VARS", data: clientVars});
          //Save the current revision in sessioninfos, should be the same as in clientVars
          sessioninfos[client.id].rev = pad.getHeadRevisionNumber();
        });
      }
        
      sessioninfos[client.id].author = author;
      
      //prepare the notification for the other users on the pad, that this user joined
      var messageToTheOtherUsers = {
        "type": "COLLABROOM",
        "data": {
          type: "USER_NEWINFO",
          userInfo: {
            "ip": "127.0.0.1",
            "colorId": authorColorId,
            "userAgent": "Anonymous",
            "userId": author
          }
        }
      };
      
      //Add the authorname of this new User, if avaiable
      if(authorName != null)
      {
        messageToTheOtherUsers.data.userInfo.name = authorName;
      }

      // notify all existing users about new user
      client.broadcast.to(padIds.padIds).json.send(messageToTheOtherUsers);
      
      //Run trough all sessions of this pad
      async.forEach(socketio.sockets.clients(padIds.padId), function(roomClient, callback)
      {
        var author;

        //Jump over, if this session is the connection session
        if(roomClient.id == client.id)
          return callback();
          
        
        //Since sessioninfos might change while being enumerated, check if the 
        //sessionID is still assigned to a valid session
        if(sessioninfos[roomClient.id] !== undefined)
          author = sessioninfos[roomClient.id].author;
        else // If the client id is not valid, callback();
          return callback();

        async.waterfall([
          //get the authorname & colorId
          function(callback)
          {
            // reuse previously created cache of author's data
            if(historicalAuthorData[author])
              callback(null, historicalAuthorData[author]);
            else
              authorManager.getAuthor(author, callback);
          }, 
          function (authorInfo, callback)
          {
            //Send the new User a Notification about this other user
            var msg = {
              "type": "COLLABROOM",
              "data": {
                type: "USER_NEWINFO",
                userInfo: {
                  "ip": "127.0.0.1",
                  "colorId": authorInfo.colorId,
                  "name": authorInfo.name,
                  "userAgent": "Anonymous",
                  "userId": author
                }
              }
            };
            client.json.send(msg);
          }
        ], callback);
      }, callback);
    }
  ],function(err)
  {
    ERR(err);
  });
}

/**
 * Handles a request for a rough changeset, the timeslider client needs it 
 */
function handleChangesetRequest(client, message)
{
  //check if all ok
  if(message.data == null)
  {
    messageLogger.warn("Dropped message, changeset request has no data!");
    return;
  }
  if(message.padId == null)
  {
    messageLogger.warn("Dropped message, changeset request has no padId!");
    return;
  }
  if(message.data.granularity == null)
  {
    messageLogger.warn("Dropped message, changeset request has no granularity!");
    return;
  }
  if(message.data.start == null)
  {
    messageLogger.warn("Dropped message, changeset request has no start!");
    return;
  }
  if(message.data.requestID == null)
  {
    messageLogger.warn("Dropped message, changeset request has no requestID!");
    return;
  }
  
  var granularity = message.data.granularity;
  var start = message.data.start;
  var end = start + (100 * granularity);
  var padIds;

  async.series([
    function (callback) {
      readOnlyManager.getIds(message.padId, function(err, value) {
        if(ERR(err, callback)) return;
        padIds = value;
        callback();
      });
    },
    function (callback) {
      //build the requested rough changesets and send them back
      getChangesetInfo(padIds.padId, start, end, granularity, function(err, changesetInfo)
      {
        ERR(err);

        var data = changesetInfo;
        data.requestID = message.data.requestID;

        client.json.send({type: "CHANGESET_REQ", data: data});
      });
    }
  ]);
}


/**
 * Tries to rebuild the getChangestInfo function of the original Etherpad
 * https://github.com/ether/pad/blob/master/etherpad/src/etherpad/control/pad/pad_changeset_control.js#L144
 */
function getChangesetInfo(padId, startNum, endNum, granularity, callback)
{
  var forwardsChangesets = [];
  var backwardsChangesets = [];
  var timeDeltas = [];
  var apool = new AttributePool();
  var pad;
  var composedChangesets = {};
  var revisionDate = [];
  var lines;
  
  async.series([
    //get the pad from the database
    function(callback)
    {
      padManager.getPad(padId, function(err, _pad)
      {        
        if(ERR(err, callback)) return;
        pad = _pad;
        callback();
      });
    },
    function(callback)
    {      
      //calculate the last full endnum
      var lastRev = pad.getHeadRevisionNumber();
      if (endNum > lastRev+1) {
        endNum = lastRev+1;
      }
      endNum = Math.floor(endNum / granularity)*granularity;
      
      var compositesChangesetNeeded = [];
      var revTimesNeeded = [];
      
      //figure out which composite Changeset and revTimes we need, to load them in bulk
      var compositeStart = startNum;
      while (compositeStart < endNum) 
      {
        var compositeEnd = compositeStart + granularity;
        
        //add the composite Changeset we needed
        compositesChangesetNeeded.push({start: compositeStart, end: compositeEnd});
        
        //add the t1 time we need
        revTimesNeeded.push(compositeStart == 0 ? 0 : compositeStart - 1);
        //add the t2 time we need
        revTimesNeeded.push(compositeEnd - 1);
        
        compositeStart += granularity;
      }
      
      //get all needed db values parallel
      async.parallel([
        function(callback)
        {
          //get all needed composite Changesets
          async.forEach(compositesChangesetNeeded, function(item, callback)
          {
            composePadChangesets(padId, item.start, item.end, function(err, changeset)
            {
              if(ERR(err, callback)) return;
              composedChangesets[item.start + "/" + item.end] = changeset;
              callback();
            });
          }, callback);
        },
        function(callback)
        {
          //get all needed revision Dates
          async.forEach(revTimesNeeded, function(revNum, callback)
          {
            pad.getRevisionDate(revNum, function(err, revDate)
            {
              if(ERR(err, callback)) return;
              revisionDate[revNum] = Math.floor(revDate/1000);
              callback();
            });
          }, callback);
        },
        //get the lines
        function(callback)
        {
          getPadLines(padId, startNum-1, function(err, _lines)
          {
            if(ERR(err, callback)) return;
            lines = _lines;
            callback();
          }); 
        }
      ], callback);
    },
    //doesn't know what happens here excatly :/
    function(callback)
    {    
      var compositeStart = startNum;
      
      while (compositeStart < endNum) 
      {
        if (compositeStart + granularity > endNum) 
        {
          break;
        }
        
        var compositeEnd = compositeStart + granularity;
      
        var forwards = composedChangesets[compositeStart + "/" + compositeEnd];
        var backwards = Changeset.inverse(forwards, lines.textlines, lines.alines, pad.apool());
        
        Changeset.mutateAttributionLines(forwards, lines.alines, pad.apool());
        Changeset.mutateTextLines(forwards, lines.textlines);
      
        var forwards2 = Changeset.moveOpsToNewPool(forwards, pad.apool(), apool);
        var backwards2 = Changeset.moveOpsToNewPool(backwards, pad.apool(), apool);
        
        var t1, t2;
        if (compositeStart == 0) 
        {
          t1 = revisionDate[0];
        }
        else 
        {
          t1 = revisionDate[compositeStart - 1];
        }
        
        t2 = revisionDate[compositeEnd - 1];
        
        timeDeltas.push(t2 - t1);
        forwardsChangesets.push(forwards2);
        backwardsChangesets.push(backwards2);
        
        compositeStart += granularity;
      }
      
      callback();
    }
  ], function(err)
  {
    if(ERR(err, callback)) return;
    
    callback(null, {forwardsChangesets: forwardsChangesets,
                    backwardsChangesets: backwardsChangesets,
                    apool: apool.toJsonable(),
                    actualEndNum: endNum,
                    timeDeltas: timeDeltas,
                    start: startNum,
                    granularity: granularity });
  });
}

/**
 * Tries to rebuild the getPadLines function of the original Etherpad
 * https://github.com/ether/pad/blob/master/etherpad/src/etherpad/control/pad/pad_changeset_control.js#L263
 */
function getPadLines(padId, revNum, callback) 
{
  var atext;
  var result = {};
  var pad;

  async.series([
    //get the pad from the database
    function(callback)
    {
      padManager.getPad(padId, function(err, _pad)
      {        
        if(ERR(err, callback)) return;
        pad = _pad;
        callback();
      });
    },
    //get the atext
    function(callback)
    {
      if(revNum >= 0)
      {
        pad.getInternalRevisionAText(revNum, function(err, _atext)
        {
          if(ERR(err, callback)) return;
          atext = _atext;
          callback();
        });
      }
      else
      {
        atext = Changeset.makeAText("\n");
        callback(null);
      }
    },
    function(callback)
    {
      result.textlines = Changeset.splitTextLines(atext.text);
      result.alines = Changeset.splitAttributionLines(atext.attribs, atext.text);
      callback(null);
    }
  ], function(err)
  {
    if(ERR(err, callback)) return;
    callback(null, result);
  });
}

/**
 * Tries to rebuild the composePadChangeset function of the original Etherpad
 * https://github.com/ether/pad/blob/master/etherpad/src/etherpad/control/pad/pad_changeset_control.js#L241
 */
function composePadChangesets(padId, startNum, endNum, callback)
{
  var pad;
  var changesets = [];
  var changeset;

  async.series([
    //get the pad from the database
    function(callback)
    {
      padManager.getPad(padId, function(err, _pad)
      {
        if(ERR(err, callback)) return;
        pad = _pad;
        callback();
      });
    },
    //fetch all changesets we need
    function(callback)
    {
      var changesetsNeeded=[];
      
      //create a array for all changesets, we will 
      //replace the values with the changeset later
      for(var r=startNum;r<endNum;r++)
      {
        changesetsNeeded.push(r);
      }
      
      //get all changesets
      async.forEach(changesetsNeeded, function(revNum,callback)
      {
        pad.getRevisionChangeset(revNum, function(err, value)
        {
          if(ERR(err, callback)) return;
          changesets[revNum] = value;
          callback();
        });
      },callback);
    },
    //compose Changesets
    function(callback)
    {
      changeset = changesets[startNum];
      var pool = pad.apool();
      
      for(var r=startNum+1;r<endNum;r++)
      {
        var cs = changesets[r];
        changeset = Changeset.compose(changeset, cs, pool);
      }
      
      callback(null);
    }
  ],
  //return err and changeset
  function(err)
  {
    if(ERR(err, callback)) return;
    callback(null, changeset);
  });
}

/**
 * Get the number of users in a pad
 */
exports.padUsersCount = function (padID, callback) {
  callback(null, {
    padUsersCount: socketio.sockets.clients(padId).length
  });
}

/**
 * Get the list of users in a pad
 */
exports.padUsers = function (padID, callback) {
  var result = [];

  async.forEach(socketio.sockets.clients(padId), function(roomClient, callback) {
    var s = sessioninfos[roomClient.id];
    if(s) {
      authorManager.getAuthor(s.author, function(err, author) {
        if(ERR(err, callback)) return;

        author.id = s.author;
        result.push(author);
      });
    }
  }, function(err) {
    if(ERR(err, callback)) return;

    callback(null, {padUsers: result});
  });
}