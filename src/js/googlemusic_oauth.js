'use strict';

const Lf = require('lovefield');
const Qs = require('qs');

const Chrometools = require('./chrometools');
const Track = require('./track');
const Trackcache = require('./trackcache');
const Playlist = require('./playlist');
const Splaylist = require('./splaylist');

const Reporting = require('./reporting');

// const GM_BASE_URL = 'htt[s://mclients.googleapis.com/sj/v1.11/';
const GM_BASE_URL = 'https://www.googleapis.com/sj/v2.5/';

// TODO dedupe with Storage
/* eslint-disable */
// Source: https://gist.github.com/jed/982883.
function uuidV1(a){
  return a?(a^Math.random()*16>>a/4).toString(16):([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, uuidV1)
}
/* eslint-enable */

function authedGMRequest(options, callback, onError) {
  // Call an endpoint and callback with it's parsed response.

  const endpoint = options.endpoint;
  const data = options.data;
  const method = options.method;
  const params = options.params;

  const qstring = Qs.stringify(params);

  const url = `${GM_BASE_URL}${endpoint}?${qstring}`;
  const dataType = 'json';

  let ajaxOnError = onError;
  if (typeof onError === 'undefined') {
    ajaxOnError = res => {
      console.error('request failed:', url, data, res);
      Reporting.Raven.captureMessage(`request to ${endpoint} failed`, {
        extra: {url, data, res},
        stacktrace: true,
      });
    };
  }

  chrome.identity.getAuthToken(Chrometools.unlessError(token => {
    const request = {
      type: method,
      contentType: 'application/json',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      url,
      dataType,
    };

    if (data) {
      request.data = JSON.stringify(data);
    }

    $.ajax(request)
    .fail(ajaxOnError)
    .done(callback);
  }));
}

// reorder example
/*
*             "text": "{\"mutations\":[{\"create\":{\"source\":1,\"trackId\":\"53cbdc43-5590-3e7b-8e25-777083254074\",\"followingEntryId\":\"CLIENT-81D216EB-15D4-4387-ACEB-93DD6B55A8B0\",\"playlistId\":\"ce371b4b-0536-3268-a361-92105641a83b\",\"clientId\":\"CLIENT-71391472-A7F5-4D3A-8545-08D6CDA6EA5E\",\"precedingEntryId\":\"72dcfbf9-a99f-3f33-bbf6-6aa6a15360b7\",\"relativePositionIdType\":1}},{\"create\":{\"source\":1,\"trackId\":\"3d9dd7b2-d940-315b-bef6-31e08c4e095c\",\"followingEntryId\":\"CLIENT-D6F33824-1232-40A0-8D33-947D7FE78903\",\"playlistId\":\"ce371b4b-0536-3268-a361-92105641a83b\",\"clientId\":\"CLIENT-81D216EB-15D4-4387-ACEB-93DD6B55A8B0\",\"precedingEntryId\":\"CLIENT-71391472-A7F5-4D3A-8545-08D6CDA6EA5E\",\"relativePositionIdType\":2}},
*             */

exports.buildPlaylistAdd = function buildPlaylistAdd(name, description) {
  // Return a playlist mutation to create a playlist.
  return {
    create: {
      name,
      description,
      creationTimestamp: '-1',
      deleted: false,
      lastModifiedTimestamp: '0',
      type: 'USER_GENERATED',
      shareState: 'PRIVATE',
    },
  };
};

exports.buildPlaylistUpdates = function buildPlaylistUpdate(updates) {
  // updates is a list of objects. Each must have 'id', and at least one of 'name', 'description', or 'shareState'.
  const mutations = [];
  for (let i = 0; i < updates.length; i++) {
    const update = updates[i];
    mutations.push({update});
  }

  return mutations;
};

exports.runPlaylistMutations = function runPlaylistMutations(user, mutations, callback) {
  const details = {
    endpoint: 'playlistbatch',
    method: 'post',
    data: {mutations},
    params: {
      'dv': 0,
      'hl': 'en-US',
      'tier': user.tier,
    },
  };
  authedGMRequest(details, response => {
    callback(response);
  });
};


// unusable: doesn't give last played timestamp
exports.getTrackChanges = function getTrackChanges(user, sinceTimestamp, callback) {
  // Callback {success: true, newTimestamp: 1234, upsertedTracks: [{}], deletedIds: ['']}, or {success: false, ...} on failure.
  // timestamps are in microseconds.

  console.debug('getTrackChanges', sinceTimestamp);

  authedGMRequest({endpoint: 'tracks', method: 'GET', data: null, params: {'dv': 0, 'hl': 'en-US', 'tier': 'aa', 'max-results': 10, 'updated-min': 1479582951000000}}, response => {
    callback(response);
  });
};

// getNext: function(pageToken, callback) => callback(response)
// callback a list of items
function consumePages(getNext, pageToken, items, callback) {
  getNext(pageToken, response => {
    if ('data' in response) {
      for (let i = 0; i < response.data.items.length; i++) {
        items.push(response.data.items[i]);
      }
    }

    const nextPageToken = response.nextPageToken;
    if (nextPageToken) {
      consumePages(getNext, nextPageToken, items, callback);
    } else {
      callback(items);
    }
  });
}

exports.getPlaylistChanges = function getPlaylistChanges(user, sinceTimestamp, callback) {
  console.debug('getPlaylistChanges', sinceTimestamp);
  const details = {
    endpoint: 'playlists',
    method: 'GET',
    data: null,
    params: {
      'dv': 0,
      'hl': 'en-US',
      'tier': 'aa',
      'max-results': 20000,
    },
  };

  if (sinceTimestamp !== null) {
    details.params['updated-min'] = sinceTimestamp;
  }

  function _getPlaylistChanges(pageToken, _callback) {
    if (pageToken) {
      details.params['start-token'] = pageToken;
    }

    authedGMRequest(details, response => {
      _callback(response);
    });
  }

  consumePages(_getPlaylistChanges, null, [], items => {
    callback(items);
  });
};

exports.getEntryChanges = function getEntryChanges(user, sinceTimestamp, callback) {
  console.debug('getEntryChanges', sinceTimestamp);
  const details = {
    endpoint: 'plentries',
    method: 'GET',
    data: null,
    params: {
      'dv': 0,
      'hl': 'en-US',
      'tier': 'aa',
      'max-results': 20000,
    },
  };

  if (sinceTimestamp !== null) {
    details.params['updated-min'] = sinceTimestamp;
  }

  function _getEntryChanges(pageToken, _callback) {
    if (pageToken) {
      details.params['start-token'] = pageToken;
    }

    authedGMRequest(details, response => {
      _callback(response);
    });
  }

  consumePages(_getEntryChanges, null, [], items => {
    callback(items);
  });
};

exports.updatePlaylist = function updatePlaylist(user, id, title, playlist, playlists, splaylistcache, callback) {
  // Callback no args after updating an existing playlist's metadata.
  const description = Playlist.toString(playlist, playlists, splaylistcache);
  const syncMsg = `Synced ${new Date().toLocaleString()} by Autoplaylists for Google Music™ to contain: ${description}.`;

  const payload = [['', 1], [id, null, title, syncMsg]];
  console.debug('updatePlaylist', playlist);

  authedGMRequest('editplaylist', payload, user, 'post', response => {
    console.debug('editPlaylist response:', JSON.stringify(response));
    callback();
  });
};

exports.createRemotePlaylist = function createRemotePlaylist(user, title, callback) {
  // Callback a playlist id for a new, empty playlist.
  const payload = [['', 1], [false, title, null, []]];

  console.debug('createRemotePlaylist', title);

  // response:
  // [[0,2,0] ,["id","some long base64 string",null,timestamp]]
  authedGMRequest('createplaylist', payload, user, 'post', response => {
    console.debug('createplaylist response:', JSON.stringify(response));
    callback(response[1][0]);
  });
};

exports.deleteRemotePlaylist = function deleteRemotePlaylist(user, remoteId, callback) {
  // Callback no args after deleting a playlist.

  const payload = {
    id: remoteId,
    requestCause: 1,
    requestType: 1,
    sessionId: '',
  };

  console.debug('deleteRemotePlaylist', remoteId);

  authedGMRequest('deleteplaylist', payload, user, 'post', response => {
    console.debug('delete playlist response', response);
    callback();
  });
};

function addTracks(user, playlistId, tracks, callback, onError) {
  // Append these tracks and callback the api response, or null if adding 0 tracks.

  if (tracks.length === 0) {
    console.debug('skipping add of 0 tracks');
    return callback(null);
  }

  console.debug('adding', tracks.length, 'tracks. first 5 are', JSON.stringify(tracks.slice(0, 5), null, 2));

  // [["<sessionid>",1],["<listid>",[["<store id or songid>",tracktype]]]]
  const payload = [['', 1],
    [
      // Google always sends [id, type] pairs, but that's caused problems for me around AA and store ids and types.
      // Just sending an id seems to work, so maybe that'll fix everything?
      playlistId, tracks.map(t => [t.id]),
    ],
  ];
  authedGMRequest('addtrackstoplaylist', payload, user, 'post', response => {
    console.debug('add response', JSON.stringify(response, null, 2));
    if (response.length <= 1 || response[1].length <= 0 || response[1][0] === 0) {
      // I used to think a [0] response array of 0, 2, 0 signaled errors,
      // but I've seen some successful responses with that recently.
      // 0 instead of the update timestamp seems a better indicator of errors.
      let responseArray = null;
      if (response.length > 0) {
        responseArray = JSON.stringify(response[0]);
      }

      Reporting.Raven.captureMessage('probable error from addTracks', {
        tags: {playlistId, responseArray},
        extra: {response, playlistId, tracks},
        stacktrace: true,
      });
    }
    callback(response);
  }, onError);
}

function deleteEntries(user, playlistId, entries, callback, onError) {
  // Delete entries with id and entryId keys; callback the api response.
  console.debug('deleting', entries.length, 'entries. first 5 are', JSON.stringify(entries.slice(0, 5), null, 2));
  const payload = [
    ['', 1],
    [playlistId, entries.map(entry => entry.id), entries.map(entry => entry.entryId)],
  ];
  authedGMRequest('deleteplaylisttrack', payload, user, 'post', response => {
    console.debug('delete response', JSON.stringify(response, null, 2));
    callback(response);
  }, onError);
}

/* 
exports.getPlaylistContents = function getPlaylistContents(user, playlistId, callback, onError) {
  // Callback a list of objects with entryId and track keys.

  authedGMRequest({endpoint: 'plentries', method: 'GET', data: null, params: {'dv': 0, 'hl': 'en-US', 'tier': 'aa', 'max-results': 1000, 'updated-min': 0}}, response => {
    callback(contents)l
    const contents = [];
    for (let i = 0; i < response.data.items.length; i++) {
      const sjEntry = response.data.items[i];
      const sjTrack = {id: sjEntry.trackId};
      contents.push({entryId: sjEntry.id, sjTrack});
    }
    callback(contents);
  }, onError);
};
*/

exports.getPlaylists = function getPlaylists(user, callback, onError) {
  // Callback a list of splaylists.

  authedGMRequest({endpoint: 'playlists', method: 'GET', data: null, params: {'dv': 0, 'hl': 'en-US', 'tier': 'aa', 'max-results': 1, 'updated-min': 0}}, response => {
    callback(response);
  }, error => {
    onError(error);
  });
};

exports.buildEntryDeletes = function buildEntryDeletes(entryIds) {
  const mutations = [];

  for (let i = 0; i < entryIds.length; i++) {
    mutations.push({'delete': entryIds[i]});
  }

  return mutations;
};

exports.buildEntryAppends = function buildEntryAppends(playlistId, trackIds) {
  const mutations = [];
  let prevId = null;
  let curId = uuidV1();
  let nextId = uuidV1();

  for (let i = 0; i < trackIds.length; i++) {
    const trackId = trackIds[i];
    const mutationBody = {
      'clientId': curId,
      'creationTimestamp': '-1',
      'deleted': false,
      'lastModifiedTimestamp': '0',
      'playlistId': playlistId,
      'source': 1,
      trackId,
    };

    if (trackId.startsWith('T')) {
      mutationBody.source = 2;
    }

    if (i > 0) {
      mutationBody.precedingEntryId = prevId;
    }
    if (i < trackIds.length - 1) {
      mutationBody.followingEntryId = nextId;
    }

    mutations.push({'create': mutationBody});
    prevId = curId;
    curId = nextId;
    nextId = uuidV1();
  }

  return mutations;
};

exports.runEntryMutations = function runEntryMutations(user, mutations, callback) {
  const details = {
    endpoint: 'plentriesbatch',
    method: 'post',
    data: {mutations},
    params: {
      'dv': 0,
      'hl': 'en-US',
      'tier': user.tier,
    },
  };
  authedGMRequest(details, response => {
    callback(response);
  });
};

exports.setPlaylistContents = function setPlaylistContents(db, user, playlistId, tracks, splaylistcache, callback, onError) {
  // Update a remote playlist to contain only the given tracks, in any order.
  // Callback an arbitrary api response, or null if adding 0 tracks.

  console.log('cache', playlistId, splaylistcache);

  let entries = [];
  if (playlistId in splaylistcache.splaylists) {
    entries = splaylistcache.splaylists[playlistId].entries;
  } else {
    console.warn('playlistid', playlistId, 'not yet cached; assuming empty');
  }

  const mutations = [];

  const deletes = buildEntryDeletes(Object.values(entries));
  for (let i = 0; i < deletes.length; i++) {
  }

  for (const entryId in entries) {
    mutations.push({'delete': entryId});
  }

  let prevId = null;
  let curId = uuidV1();
  let nextId = uuidV1();
  for (let i = 0; i < tracks.length; i++) {
    const mutationBody = {
      'clientId': curId,
      'creationTimestamp': '-1',
      'deleted': false,
      'lastModifiedTimestamp': '0',
      'playlistId': playlistId,
      'source': 1,
      'trackId': tracks[i].id,
    };

    if (tracks[i].id.startsWith('T')) {
      mutationBody.source = 2;
    }

    if (i > 0) {
      mutationBody.precedingEntryId = prevId;
    }
    if (i < tracks.length - 1) {
      mutationBody.followingEntryId = nextId;
    }

    mutations.push({'create': mutationBody});
    prevId = curId;
    curId = nextId;
    nextId = uuidV1();
  }

  authedGMRequest({endpoint: 'plentriesbatch', method: 'POST', data: {mutations}, params: {'dv': 0, 'hl': 'en-US', 'tier': 'free', 'alt': 'json'}}, response => {
    console.log(response);
    callback(null);
  }, error => {
    onError(error);
  });
};

exports.setPlaylistOrder = function setPlaylistOrder(db, user, playlist, callback, onError) {
  // Set the remote ordering of a playlist according to playlist's sort order.
  // This trusts that the remote contents are already correct.

  // This approach handles the maybe-playing tracks that wouldn't be in our tracks
  // if we queried them locally.

  exports.getPlaylistContents(user, playlist.remoteId, contents => {
    if (contents.length !== 0) {
      // Reordering calls deal in entry ids, not track ids.
      const currentOrdering = [];
      const desiredOrdering = [];
      const idToEntryId = {};

      for (let i = 0; i < contents.length; i++) {
        idToEntryId[contents[i].track.id] = contents[i].entryId;
        currentOrdering.push(contents[i].entryId);
      }

      const remoteTracks = contents.map(c => c.track);

      Trackcache.orderTracks(db, playlist, remoteTracks, orderedTracks => {
        for (let i = 0; i < orderedTracks.length; i++) {
          const track = orderedTracks[i];
          desiredOrdering.push(idToEntryId[track.id]);
        }

        // It's ridiculous that javascript doesn't have a builtin for this.
        // Thankfully we have simple items and can get away with this hack.
        if (JSON.stringify(currentOrdering) !== JSON.stringify(desiredOrdering)) {
          // The two empty strings are sentinels for "first track" and "last track".
          // This lets us send our entire reordering at once without calculating the relative movements.
          // I'm not sure if the interface was intended to be used this way, but it seems to work.
          const payload = [['', 1], [desiredOrdering, '', '']];
          authedGMRequest('changeplaylisttrackorder', payload, user, 'post', response => {
            // TODO These should all be checked for errors.
            // It looks like responses will have [[0, 1, 1], [call-specific response]] on success.
            callback(response);
          }, onError);
        } else {
          // Avoid triggering a ui refresh on noop reorderings.
          console.debug('no need to reorder playlist', playlist.title);
          callback(null);
        }
      }, e => {
        console.error(e);
        onError(e);
      });
    } else {
      console.debug('no need to reorder empty playlist', playlist.title);
      callback(null);
    }
  }, onError);
};
