/**
 * Last.fm Scrobbler for Chrome
 * by David Sabata
 *
 * https://github.com/david-sabata/Chrome-Last.fm-Scrobbler
 *
 *
 * TODOs
 *
 * - add second validation to nowPlaying request handler or trust the data to be valid?
 *
 */
define([
	'jquery',
	'config',
	'notifications',
	'services/lastfm',
	'services/background-ga',
	'helpers'
], function($, config, notifications, LastFM, GA, helpers) {

	// browser tab with actually scrobbled track
	var nowPlayingTab = null;

	// song structure, filled in nowPlaying phase, (artist, track, album, duration, startTime)
	var song = {};

	// timer to submit the song
	var scrobbleTimeout = null;

	// is scrobbling disabled?
	var disabled = false;

	// set up page action handler; use dummy.html popup to override
	chrome.pageAction.onClicked.addListener(pageActionClicked);


	/**
	 * Default settings & update notification
	 */
	{
	   // use notifications by default
	   if (localStorage.useNotifications == null)
	      localStorage.useNotifications = 1;

	   // no disabled connectors by default
	   if (localStorage.disabledConnectors == null)
	      localStorage.disabledConnectors = JSON.stringify([]);

	   // show update popup - based on different version
	   if (localStorage.appVersion != chrome.app.getDetails().version) {
	      localStorage.appVersion = chrome.app.getDetails().version;

	      // introduce new options if not already set
	      if (typeof localStorage.useAutocorrect == 'undefined')
	         localStorage.useAutocorrect = 0;
	   }
	}


	function reset() {
	   console.log('reset called');
	   if (scrobbleTimeout != null) {
	      clearTimeout(scrobbleTimeout);
	      scrobbleTimeout = null;
	   }

	   nowPlayingTab = null;
	   song = {};
	}


	/**
	 * Creates query string from object properties
	 */
	function createQueryString(params) {
	   var parts = new Array();

	   for (var x in params)
	      parts.push( x + '=' + encodeUtf8( params[x] ) );

	   return parts.join('&');
	}


	/**
	 * Encodes the utf8 string to use in parameter of API call
	 */
	function encodeUtf8(s) {
	   return encodeURIComponent( s );
	}

	/**
	 * Page action onclick handler. Switches scrobbling off and on
	 * and calls setActionIcon to re-set the icon accordingly
	 */
	function pageActionClicked(tabObj) {
	   // switch
	   disabled = !disabled;

	   // set up new icon
	   if (disabled) {
	      reset();
	      setActionIcon(config.ACTION_DISABLED, tabObj.id);
	   } else {
	      setActionIcon(config.ACTION_REENABLED, tabObj.id);
	   }
	}


	/**
	 * Sets up page action icon, including title and popup
	 *
	 * @param {integer} action one of the ACTION_ constants
	 * @param {integer} tabId
	 */
	function setActionIcon(action, tabId) {

	   var tab = tabId ? tabId : nowPlayingTab;
	   chrome.pageAction.hide(tab);

	   switch(action) {
	      case config.ACTION_UNKNOWN:
	         chrome.pageAction.setIcon({tabId: tab, path: config.ICON_UNKNOWN});
	         chrome.pageAction.setTitle({tabId: tab, title: 'Song not recognized. Click the icon to correct its title'});
	         chrome.pageAction.setPopup({tabId: tab, popup: 'popup.html'});
	         break;
	      case config.ACTION_NOWPLAYING:
	         chrome.pageAction.setIcon({tabId: tab, path: config.ICON_NOTE});
	         chrome.pageAction.setTitle({tabId: tab, title: 'Now playing: ' + song.artist + ' - ' + song.track + '\nClick to disable scrobbling'});
	         chrome.pageAction.setPopup({tabId: tab, popup: ''});
	         break;
	      case config.ACTION_SCROBBLED:
	         chrome.pageAction.setIcon({tabId: tab, path: config.ICON_TICK});
	         chrome.pageAction.setTitle({tabId: tab, title: 'Song has been scrobbled\nClick to disable scrobbling'});
	         chrome.pageAction.setPopup({tabId: tab, popup: ''});
	         break;
	      case config.ACTION_DISABLED:
	         chrome.pageAction.setIcon({tabId: tab, path: config.ICON_NOTE_DISABLED});
	         chrome.pageAction.setTitle({tabId: tab, title: 'Scrobbling is disabled\nClick to enable'});
	         chrome.pageAction.setPopup({tabId: tab, popup: ''});
	         break;
	      case config.ACTION_REENABLED:
	         chrome.pageAction.setIcon({tabId: tab, path: config.ICON_TICK_DISABLED});
	         chrome.pageAction.setTitle({tabId: tab, title: 'Scrobbling will continue for the next song'});
	         chrome.pageAction.setPopup({tabId: tab, popup: ''});
	         break;
	      case config.ACTION_CONN_DISABLED:
	         chrome.pageAction.setIcon({tabId: tab, path: config.ICON_CONN_DISABLED});
	         chrome.pageAction.setTitle({tabId: tab, title: 'Scrobbling for this site is disabled, most likely because the site has changed its layout. Please contact the connector author.'});
	         chrome.pageAction.setPopup({tabId: tab, popup: ''});
	         break;
	      case config.ACTION_SITE_RECOGNIZED:
	         chrome.pageAction.setIcon({tabId: tab, path: config.ICON_LOGO});
	         chrome.pageAction.setTitle({tabId: tab, title: 'This site is supported for scrobbling'});
	         chrome.pageAction.setPopup({tabId: tab, popup: ''});
	         break;
	      case config.ACTION_SITE_DISABLED:
	         chrome.pageAction.setIcon({tabId: tab, path: config.ICON_LOGO});
	         chrome.pageAction.setTitle({tabId: tab, title: 'This site is supported, but you disabled it'});
	         chrome.pageAction.setPopup({tabId: tab, popup: ''});
	         break;
	   }

	   chrome.pageAction.show(tab);
	}


	/**
	 * Retrieves a token and opens a new window for user to authorize it
	 */
	function authorize() {
	   var http_request = new XMLHttpRequest();
	   http_request.open("GET", config.apiURL + 'method=auth.gettoken&api_key=' + config.apiKey, false); // synchronous
	   http_request.setRequestHeader("Content-Type", "application/xml");
	   http_request.send(null);

	   console.log('getToken response: %s', http_request.responseText);

	   var xmlDoc = $.parseXML(http_request.responseText);
	   var xml = $(xmlDoc);
	   var status = xml.find('lfm').attr('status');

	   if (status != 'ok') {
	      console.log('Error acquiring a token: %s', http_request.responseText);
	      localStorage.token = '';
	   } else {
	      localStorage.token = xml.find('token').text();

	      // open a tab with token authorization
	      var url = 'https://libre.fm/api/auth/?api_key=' + config.apiKey + '&token=' + localStorage.token;
	      window.open(url, 'scrobbler-auth');
	   }
	}

	/**
	 * Retrieve sessionID token if not already available
	 * Returns false if the sessionID cannot be retrieved (try again later - user has to authorize)
	 */
	function getSessionID() {
	   // check for a token first
	   if (!localStorage.token || localStorage.token == '') {
	      authorize();
	      return false;
	   }

	   // do we already have a session?
	   if (localStorage.sessionID && localStorage.sessionID != '')
	      return localStorage.sessionID;

	   var params = {
	      method: 'auth.getsession',
	      api_key: config.apiKey,
	      token: localStorage.token
	   };
	   var api_sig = LastFM.generateSign(params);
	   var url = config.apiURL + createQueryString(params) + '&api_sig=' + api_sig;

	   var http_request = new XMLHttpRequest();
	   http_request.open("GET", url, false); // synchronous
	   http_request.setRequestHeader("Content-Type", "application/xml");
	   http_request.send(null);

	   console.log('getSession reponse: %s', http_request.responseText);

	   var xmlDoc = $.parseXML(http_request.responseText);
	   var xml = $(xmlDoc);
	   var status = xml.find('lfm').attr('status');

	   if (status != 'ok') {
	      console.log('getSession: the token probably hasn\'t been authorized');
	      localStorage.sessionID = '';
	      authorize();
	   } else {
	      localStorage.sessionID = xml.find('key').text();
	      return localStorage.sessionID;
	   }

	   return false;
	}



	/**
	 * Validate song info against last.fm and calls callback with valid song structure
	 * or false in case of failure as parameter
	 */
	function validate(artist, track, callback) {
		// dummy song structure - we dont use it globally yet
		var songObj = helpers.createEmptySong();
		songObj.attr({
			artist: artist,
			track: track
		});

		// setup listening so we can reply to connector
		songObj.bind('internal.attemptedLFMValidation', function(ev, newVal) {
			if (newVal === true) {
				if (songObj.internal.isLFMValid === false) {
					callback(false);
				} else {
					// create plain old song object to maintain compatibility
					var validSong = {
						artist: songObj.artist,
						track: songObj.track,
						duration: songObj.duration * 1000 // legacy api expects miliseconds
					};

					callback(validSong);
				}
			}
		});

		LastFM.loadSongInfo(songObj);
	}



	/**
	 * Tell server which song is playing right now (won't be scrobbled yet!)
	 */
	function nowPlaying(song) {
	   console.log('nowPlaying called for %s - %s (%s)', song.artist, song.track, song.album);
	   console.log(song);
	   if (disabled) {
	      console.log('scrobbling disabled; exitting nowPlaying');
	      return;
	   }

	   // if the token/session is not authorized, wait for a while
	   var sessionID = getSessionID();
	   if (sessionID === false)
	      return;

	   var params = {
	      method: 'track.updatenowplaying',
	      track: song.track,
	      artist: song.artist,
	      api_key: config.apiKey,
	      sk: sessionID
	   };

	   if(typeof(song.album) != 'undefined' && song.album != null) {
	      params["album"] = song.album;
	   }
	   if(typeof(song.duration) != 'undefined' && song.duration != null) {
	      params["duration"] = song.duration;
	   }

	   var api_sig = LastFM.generateSign(params);
	   var url = config.apiURL + createQueryString(params) + '&api_sig=' + api_sig;

	   var http_request = new XMLHttpRequest();
	   http_request.open("POST", url, false); // synchronous
	   http_request.setRequestHeader("Content-type", "application/x-www-form-urlencoded");
	   http_request.send(params);

	   console.log('nowPlaying request: %s', url);
	   console.log('nowPlaying response: %s', http_request.responseText);

	   var xmlDoc = $.parseXML(http_request.responseText);
	   var xml = $(xmlDoc);

	   if (xml.find('lfm').attr('status') == 'ok') {
	         console.log('now playing %s - %s', song.artist, song.track);

	         // Confirm the content_script, that the song is "now playing"
	         chrome.tabs.sendMessage(nowPlayingTab, {type: "nowPlayingOK"});

	         // Show notification
	         notifications.showPlaying(song);

	         // Update page action icon
	         setActionIcon(config.ACTION_NOWPLAYING);
	   } else {
	      notifications.showError('Please see http://status.last.fm and check if everything is OK');
	   }
	}




	/**
	 * Finally scrobble the song, but only if it has been playing long enough.
	 * Cleans global variables "song", "playingTab" and "scrobbleTimeout" on success.
	 */
	function submit() {
	   // bad function call
	   if (song == null || !song || song.artist == '' || song.track == '' || typeof(song.artist) == "undefined" || typeof(song.track) == "undefined" ) {
	      reset();
	      chrome.tabs.sendMessage(nowPlayingTab, {type: "submitFAIL", reason: "No song"});
	      return;
	   }

	   // if the token/session is not authorized, wait for a while
	   var sessionID = getSessionID();
	   if (sessionID === false)
	      return;

	   console.log('submit called for %s - %s (%s)', song.artist, song.track, song.album);

	   var params = {
	      method: 'track.scrobble',
	      'timestamp[0]': song.startTime,
	      'track[0]': song.track,
	      'artist[0]': song.artist,
	      api_key: config.apiKey,
	      sk: sessionID
	   };

	   if(typeof(song.album) != 'undefined' && song.album != null) {
	      params["album[0]"] = song.album;
	   }

	   if(typeof(song.source) != 'undefined' && song.source != null) {
	      params["source[0]"] = song.source;
	   }

	   if(typeof(song.sourceId) != 'undefined' && song.sourceId != null) {
	      params["sourceId[0]"] = song.sourceId;
	   }

	   var api_sig = LastFM.generateSign(params);
	   var url = config.apiURL + createQueryString(params) + '&api_sig=' + api_sig;

	   var http_request = new XMLHttpRequest();
	   http_request.open("POST", url, false); // synchronous
	   http_request.setRequestHeader("Content-type", "application/x-www-form-urlencoded");
	   http_request.send(params);

	   if (http_request.status == 200) {
	      // Update page action icon
	      setActionIcon(config.ACTION_SCROBBLED);

	      // stats
	      GA.send('event', 'legacy', 'scrobble', song.artist + ' - ' + song.track);

	      console.log('submitted %s - %s (%s)', song.artist, song.track, http_request.responseText);

	      // Confirm the content script, that the song has been scrobbled
	      if (nowPlayingTab)
	        chrome.tabs.sendMessage(nowPlayingTab, {type: "submitOK", song: {artist:song.artist, track: song.track}});

	   }
	   else if (http_request.status == 503) {
	      console.log('submit failed %s - %s (%s)', song.artist, song.track, http_request.responseText);
	      notifications.showError('Please see http://status.last.fm and check if everything is OK');
	   }
	   else {
	      console.log('submit failed %s - %s (%s)', song.artist, song.track, http_request.responseText);
	      notifications.showError('Please see http://status.last.fm and check if everything is OK');
	   }

	   // clear the structures awaiting the next song
	   reset();
	}



	/**
	 * Extension inferface for content_script
	 * nowPlaying(artist, track, currentTime, duration) - send info to server which song is playing right now
	 * xhr(url) - send XHR GET request and return response text
	 * newSession() - start a new last.fm session (need to reauthenticate)
	 * validate(artist, track) - validate artist-track pair against last.fm and return false or the valid song
	 */
	chrome.runtime.onMessage.addListener(
		function(request, sender, sendResponse) {
	         switch(request.type) {

	            // Called when a new song has started playing. If the artist/track is filled,
	            // they have to be already validated! Otherwise they can be corrected from the popup.
	            // Also sets up a timout to trigger the scrobbling procedure (when all data are valid)
	        case "nowPlaying":
	                  console.log('nowPlaying %o', request);

	                  // do the reset to be sure there is no other timer running
	                  reset();

	                  // remember the caller
	                  nowPlayingTab = sender.tab.id;

	                  // scrobbling disabled?
	                  if (disabled) {
	                     setActionIcon(config.ACTION_DISABLED, nowPlayingTab);
	                     break;
	                  }

	                  // backward compatibility for connectors which dont use currentTime
	                  if (typeof(request.currentTime) == 'undefined' || !request.currentTime)
	                     request.currentTime = 0;

	                  // data missing, save only startTime and show the unknown icon
	                  if (typeof(request.artist) == 'undefined' || !request.artist
	                      || typeof(request.track) == 'undefined' || !request.track)
	                  {
	                     // fill only the startTime, so the popup knows how to set up the timer
	                     song = {
	                        startTime : parseInt(new Date().getTime() / 1000.0) // in seconds
	                     };

	                     // if we know something...
	                     if (typeof(request.artist) != 'undefined' && request.artist) {
	                        song.artist = request.artist;
	                     }
	                     if (typeof(request.track) != 'undefined' && request.track) {
	                        song.track = request.track;
	                     }
	                     if (typeof(request.currentTime) != 'undefined' && request.currentTime) {
	                        song.currentTime = request.currentTime;
	                     }
	                     if (typeof(request.duration) != 'undefined' && request.duration) {
	                        song.duration = request.duration;
	                     }
	                     if (typeof(request.album) != 'undefined' && request.album) {
	                        song.album = request.album;
	                     }
	                     if (typeof(request.sourceId) != 'undefined' && request.sourceId) {
	                        song.sourceId = request.sourceId;
	                     }
	                     if (typeof(request.source) != 'undefined' && request.source) {
	                        song.source = request.source;
	                     }

	                     // Update page action icon to 'unknown'
	                     setActionIcon(config.ACTION_UNKNOWN, sender.tab.id);
	                  }
	                  // all data are avaliable and valid, set up the timer
	                  else {
	                     // fill the new playing song
	                     song = {
	                        artist : request.artist,
	                        track : request.track,
	                        currentTime : request.currentTime,
	                        duration : request.duration,
	                        startTime : ( parseInt (new Date().getTime() / 1000.0) - request.currentTime) // in seconds
	                     }

	                     if(typeof(request.album) != 'undefined') {
	                        song.album = request.album;
	                     }
	                     if (typeof(request.sourceId) != 'undefined' && request.sourceId) {
	                        song.sourceId = request.sourceId;
	                     }
	                     if (typeof(request.source) != 'undefined' && request.source) {
	                        song.source = request.source;
	                     }


	                     // make the connection to last.fm service to notify
	                     nowPlaying(song);

	                     // The minimum time is 240 seconds or half the
	                     // track's total length. Subtract the song's
	                     // current time (for the case of unpausing).
	                     var min_time = (Math.max(1, Math.min(240, song.duration / 2) - song.currentTime));
	                     // Set up the timer
	                     scrobbleTimeout = setTimeout(submit, min_time * 1000);
	                  }

	            sendResponse({});
	            break;

	            // called when the window closes / unloads before the song can be scrobbled
	            case "reset":
	                  reset();
	                  sendResponse({});
	                  break;

	            case "trackStats":
					// intentionally not used - will be replaced by new connector API
					//_gaq.push(['_trackEvent', request.text]);
					sendResponse({});
	            break;

	            // do we need this anymore? (content script can use ajax)
	            case "xhr":
	            var http_request = new XMLHttpRequest();
	            http_request.open("GET", request.url, true);
	            http_request.onreadystatechange = function() {
	                if (http_request.readyState == 4 && http_request.status == 200)
	                    sendResponse({text: http_request.responseText});
	            };
	            http_request.send(null);
	            break;

	            // for login
	        case "newSession":
	            sessionID = "";
	            break;

	            // connector tells us it is disabled
	        case "reportDisabled":
	            setActionIcon(config.ACTION_CONN_DISABLED, sender.tab.id);
	            break;

	            // Checks if the request.artist and request.track are valid and
	            // returns false if not or a song structure otherwise (may contain autocorrected values)
	        case "validate":
				// quick deny for bad/incomplete info
				if (!request.artist || !request.track) {
					sendResponse(false);
				}
				// use new API module to validate
				else {
					validate(request.artist, request.track, sendResponse);
				}
				break;


	         // Interface for new V2 functionality. Routes control flow to new structures, so we can
	         // have two cores side by side. The old functionality will be later removed
	         case 'v2.stateChanged':
				 console.log('received v2: ' + JSON.stringify(request));
		         console.err('not implemented yet');
		         break;


	            default:
	                  console.log('Unknown request: %s', JSON.stringify(request));
	         }

	         return true;
		}
	);

	// globals to be accessed from popup window
	window.popupApi = {
		getSong: function() { return song; },
		nowPlaying: nowPlaying,
		submit: submit,
		validate: validate,
		planSubmit: function(minTime) {
			scrobbleTimeout = setTimeout(submit, minTime);
		}
	};



	// public api (used in inject and options)
	return {
		authorize: authorize,
		setActionIcon: setActionIcon
	};

});