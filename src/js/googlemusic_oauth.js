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

exports.buildEntryDeletes = function buildEntryDeletes(entryIds) {
  const mutations = [];

  for (let i = 0; i < entryIds.length; i++) {
    mutations.push({'delete': entryIds[i]});
  }

  return mutations;
};

exports.buildEntryReorders = function buildEntryReorders(reorders) {
  const mutations = [];

  for (let i = 0; i < reorders.length; i++) {
    mutations.push({'update': reorders[i]});
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
