'use strict';

const Qs = require('qs');

const Chrometools = require('./chrometools.js');
const Gm = require('./googlemusic.js');
const License = require('./license.js');
const Storage = require('./storage.js');
const Trackcache = require('./trackcache.js');

// {userId: {userIndex: int, tabId: int}}
const users = {};

// {userId: <lovefield db>}
const dbs = {};

// {userId: <bool>}
const dbIsInit = {};

// {playlistId: <bool>}, locks playlists during some updates
const playlistIsUpdating = {};

function userIdForTabId(tabId) {
  for (const userId in users) {
    if (users[userId].tabId === tabId) {
      return userId;
    }
  }
}

function userIndexForId(userId) {
  console.log('index for', userId, users[userId].userIndex);
  return users[userId].userIndex;
}

function timestampKey(userId) {
  return 'lastPoll-' + userId;
}

function setPollTimestamp(userId, timestamp) {
  const storageItems = {};
  storageItems[timestampKey(userId)] = timestamp;
  chrome.storage.local.set(storageItems, Chrometools.unlessError(() => {
    console.log('set poll for', userId, timestamp);
  }));
}

function getPollTimestamp(userId, callback) {
  const key = timestampKey(userId);
  chrome.storage.local.get(key, Chrometools.unlessError(items => {
    const timestamp = items[key];
    console.log('get poll for', userId, timestamp);
    callback(timestamp);
  }));
}

function diffUpdateLibrary(userId, timestamp, callback) {
  // Update our cache with any changes since our last poll.

  Gm.getTrackChanges(userIndexForId(userId), timestamp, changes => {
    Trackcache.upsertTracks(dbs[userId], userId, changes.upsertedTracks, () => {
      console.log('done with diff upsert of', changes.upsertedTracks.length);
      Trackcache.deleteTracks(dbs[userId], userId, changes.deletedIds, () => {
        console.log('done with diff delete of', changes.deletedIds.length);
        dbIsInit[userId] = true;

        if (changes.newTimestamp) {
          setPollTimestamp(userId, changes.newTimestamp);
        }

        callback();
      });
    });
  });
}

function initLibrary(userId) {
  // Initialize our cache from Google's indexeddb, or fall back to a differential update from time 0.

  const message = {action: 'getLocalTracks', userId};
  chrome.tabs.sendMessage(users[userId].tabId, message, Chrometools.unlessError(response => {
    if (response.tracks === null) {
      // problem with indexeddb, fall back to update from 0.
      diffUpdateLibrary(userId, 0, () => {});
    } else {
      console.log('got tracks', response.tracks.length);
      Trackcache.upsertTracks(dbs[userId], userId, response.tracks, () => {
        dbIsInit[userId] = true;

        // we don't want to set the poll timestamp here since
        // the indexeddb is only written on page load.
        console.log('done with refresh of', response.tracks.length, 'tracks');
      });
    }
  }));
}

function syncPlaylist(playlist, attempt) {
  // Make Google's playlist match the given one.

  const userIndex = userIndexForId(playlist.userId);
  const _attempt = attempt || 0;

  console.log('syncPlaylist, attempt', _attempt);

  if (!('remoteId' in playlist)) {
    // Create a remote playlist.
    Gm.createRemotePlaylist(userIndex, playlist.title, remoteId => {
      console.log('created remote playlist', remoteId);
      const playlistToSave = JSON.parse(JSON.stringify(playlist));
      playlistToSave.remoteId = remoteId;

      Storage.savePlaylist(playlistToSave, () => {
        // nothing else to do. listener will see the change and recall.
        console.log('wrote remote id');
      });
    });
  } else {
    // refresh tracks and write out playlist
    const db = dbs[playlist.userId];
    Trackcache.queryTracks(db, playlist, tracks => {
      console.log('lock', playlist.title);
      playlistIsUpdating[playlist.remoteId] = true;
      console.log(playlist.title, 'found', tracks.length);
      if (tracks.length > 0) {
        console.log('first is', tracks[0]);
      }
      if (tracks.length > 1000) {
        console.warn('attempting to sync over 1000 tracks; only first 1k will sync');
      }

      const desiredTracks = tracks.slice(0, 1000);

      Gm.setPlaylistContents(db, userIndex, playlist.remoteId, desiredTracks, response => {
        if (response !== null) {
          // large updates seem to only apply partway sometimes.
          // retrying like this seems to make even 1k playlists eventually consistent.
          if (_attempt < 5) {
            console.log('not a 0-track add; retrying syncPlaylist', response);
            setTimeout(syncPlaylist, 1000 * _attempt + 1000, playlist, _attempt + 1);
          } else {
            console.warn('giving up on syncPlaylist!', response);
            // Never has the need for promises been so clear.
            Gm.setPlaylistOrder(db, userIndex, playlist, orderResponse => {
              console.log('reorder response', orderResponse);
              console.log('unlock', playlist.title);
              playlistIsUpdating[playlist.remoteId] = false;
            }, err => {
              console.error('failed to reorder playlist', playlist.title, err);
              console.log('unlock', playlist.title);
              playlistIsUpdating[playlist.remoteId] = false;
            });
          }
        } else {
          Gm.setPlaylistOrder(db, userIndex, playlist, orderResponse => {
            console.log('reorder response', orderResponse);
            console.log('unlock', playlist.title);
            playlistIsUpdating[playlist.remoteId] = false;
          }, err => {
            console.error('failed to reorder playlist', playlist.title, err);
            console.log('unlock', playlist.title);
            playlistIsUpdating[playlist.remoteId] = false;
          });
        }
      }, err => {
        console.error('failed to sync playlist', playlist.title, err);
        console.log('unlock', playlist.title);
        playlistIsUpdating[playlist.remoteId] = false;
      });
    });
  }
}

function renameAndSync(playlist) {
  console.log('renaming to', playlist.title);
  Gm.updatePlaylist(userIndexForId(playlist.userId), playlist.remoteId, playlist.title, playlist, () => {
    syncPlaylist(playlist);
  });
}

function forceUpdate(userId) {
  getPollTimestamp(userId, timestamp => {
    if (!(dbIsInit[userId])) {
      console.warn('refusing forceUpdate because db is not init');
      return;
    } else if (!timestamp) {
      console.warn('db was init, but no timestamp found');
      return;
    }

    diffUpdateLibrary(userId, timestamp, () => {
      License.hasFullVersion(false, hasFullVersion => {
        Storage.getPlaylistsForUser(userId, playlists => {
          for (let i = 0; i < playlists.length; i++) {
            if (i > 0 && !hasFullVersion) {
              console.log('skipping sync of locked playlist', playlists[i].title);
              continue;
            }
            // This locking prevents two things:
            //   * slow periodic syncs from stepping on later periodic syncs
            //   * periodic syncs from stepping on manual syncs
            // which is why it's done at this level (and not around eg syncPlaylist).
            if (playlistIsUpdating[playlists[i].remoteId]) {
              console.warn('skipping forceUpdate since playlist is being updated:', playlists[i].title);
            } else {
              renameAndSync(playlists[i]);
            }
          }
        });
      });
    });
  });
}

function main() {
  Storage.addPlaylistChangeListener(change => {
    const hasOld = 'oldValue' in change;
    const hasNew = 'newValue' in change;

    if (hasOld && !hasNew) {
      // deletion
      Gm.deleteRemotePlaylist(userIndexForId(change.oldValue.userId), change.oldValue.remoteId, () => {});
    } else if (hasOld && hasNew) {
      // update
      if (change.oldValue.title !== change.newValue.title) {
        renameAndSync(change.newValue);
      } else {
        syncPlaylist(change.newValue);
      }
    } else {
      // creation
      syncPlaylist(change.newValue);
    }
  });

  chrome.pageAction.onClicked.addListener(tab => {
    let managerUrl = chrome.extension.getURL('html/playlists.html');
    managerUrl = managerUrl + '?' + Qs.stringify({userId: userIdForTabId(tab.id)});
    Chrometools.focusOrCreateExtensionTab(managerUrl);
  });

  // Update periodically.
  setInterval(() => {
    for (const userId in users) {
      console.log('periodic update for', userId);
      forceUpdate(userId);
    }
  }, 60 * 1000);

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // respond to manager / content script requests.

    if (request.action === 'forceUpdate') {
      forceUpdate(request.userId);
    } else if (request.action === 'showPageAction') {
      if (!(request.userId)) {
        console.warn('received falsey user id from page action');
        return false;
      }

      if (!(request.userId in dbs)) {
        // init the db.
        Trackcache.openDb(request.userId, db => {
          // TODO there's a race condition here between poll timestamp reads and
          // writes if users manage to forceUpdate before this write finishes.
          // that seems super unlikely so i haven't addressed it yet.
          setPollTimestamp(request.userId, new Date().getTime() * 1000);
          console.log('opened');
          dbs[request.userId] = db;

          // indexeddb is super slow.
          // much faster to use memory store and refresh on load.
          initLibrary(request.userId);
        });
      }

      // In the case that an existing tab/index was changed to a new user,
      // remove the old entry.
      for (const userId in users) {
        if (users[userId].tabId === sender.tab.id ||
            users[userId].userIndex === request.userIndex) {
          delete users[userId];
        }
      }

      users[request.userId] = {userIndex: request.userIndex, tabId: sender.tab.id};
      console.log('see user', request.userId, users);
      License.hasFullVersion(false, hasFullVersion => {console.log('precached license status:', hasFullVersion);});
      chrome.pageAction.show(sender.tab.id);
    } else if (request.action === 'query') {
      Trackcache.queryTracks(dbs[request.playlist.userId], request.playlist, tracks => {
        sendResponse({tracks});
      });
      return true; // wait for async response
    } else {
      console.warn('received unknown request', request);
    }
  });
}

Storage.handleMigrations(main);