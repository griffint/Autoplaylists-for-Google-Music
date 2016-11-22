'use strict';

const Qs = require('qs');

const Chrometools = require('./chrometools');
const Gm = require('./googlemusic');
const Gmoauth = require('./googlemusic_oauth');
const Lf = require('lovefield');  // made available for debugQuery eval
const License = require('./license');
const Playlist = require('./playlist');
const Storage = require('./storage');
const Track = require('./track');
const Trackcache = require('./trackcache');
const Splaylistcache = require('./splaylistcache');

const Context = require('./context');
const Reporting = require('./reporting');

// {userId: {userIndex: int, tabId: int, xt: string, tier: string, gaiaId: string}}
const users = {};

// {userId: <lovefield db>}
const dbs = {};

// {userId: splaylistCache}
const splaylistcaches = {};

// {playlistId: <bool>}, locks playlists during some updates
const playlistIsUpdating = {};

// {userId: <timestamp>}
const pollTimestamps = {};

// set to a string at startup
let primaryGaiaId = null;

let syncsHaveStarted = false;

// TODO dedupe
/* eslint-disable */
// Source: https://gist.github.com/jed/982883.
function uuidV1(a){
  return a?(a^Math.random()*16>>a/4).toString(16):([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, uuidV1)
}
/* eslint-enable */

function userIdForTabId(tabId) {
  for (const userId in users) {
    if (users[userId].tabId === tabId) {
      return userId;
    }
  }
}

function deauthUser(userId) {
  console.info('deauthing', userId);
  delete users[userId];
  delete dbs[userId];
  delete pollTimestamps[userId];
  delete splaylistcaches[userId];
}


function diffUpdateTrackcache(userId, db, callback, timestamp) {
  // Update our cache with any changes since timestamp.
  // Callback an object with success = true if we were able to retrieve changes.

  // If timestamp is not provided, use the last stored timestamp.
  // If there is no stored timestamp, use 0 (a full sync).

  const user = users[userId];
  if (!Number.isInteger(timestamp)) {
    timestamp = pollTimestamps[userId] || 0;  // eslint-disable-line no-param-reassign
  }

  console.log('checking for remote track changes');
  Gm.getTrackChanges(user, timestamp, changes => {
    if (!changes.success) {
      console.warn('failed to getTrackChanges:', JSON.stringify(changes));
      if (changes.reloadXsrf) {
        chrome.tabs.sendMessage(user.tabId, {action: 'getXsrf'}, Chrometools.unlessError(r => {
          console.info('requested xsrf refresh', r);
        },
        e => {
          console.warn('failed to request xsrf refresh; deauthing', JSON.stringify(e));
          Reporting.Raven.captureMessage('failed to request xsrf refresh; deauthing', {
            level: 'warning',
            extra: {changes, timestamp, e: JSON.stringify(e)},
          });
          deauthUser(userId);
        }));
      } else if (changes.unauthed) {
        console.info('unauthed', userId);
        deauthUser(userId);
      } else {
        console.error('unexpected getTrackChanges response', changes);
        Reporting.Raven.captureMessage('unexpected getTrackChanges response', {
          extra: {changes, timestamp},
        });
      }
      return callback({success: false});
    }

    Trackcache.upsertTracks(db, userId, changes.upsertedTracks, () => {
      Trackcache.deleteTracks(db, userId, changes.deletedIds, () => {
        if (changes.newTimestamp) {
          pollTimestamps[userId] = changes.newTimestamp;
          console.log('poll timestamp now Google-provided', changes.newTimestamp);
        } else if (timestamp === 0) {
          // if we're updating from 0 and didn't get a new timestamp, we want to avoid updating from 0 again.
          // so, use the current time minus a minute to avoid race conditions from when the sync started.
          pollTimestamps[userId] = (new Date().getTime() * 1000) - (60 * 1000);
          console.info('no new poll timestamp; using one minute ago');
        } else {
          // This happens when the diff update had no changes.
          // We can just use the same timestamp again next time.
          pollTimestamps[userId] = timestamp;
          console.log('no new poll timestamp; reusing', timestamp);
        }

        callback({success: true});
      });
    });
  });
}

function syncPlaylistContents(playlist, attempt) {
  // Sync a playlist's tracks and ordering.
  // A remote playlist must already exist.

  const user = users[playlist.userId];
  const _attempt = attempt || 0;
  const db = dbs[playlist.userId];
  const splaylistcache = splaylistcaches[playlist.userId];

  console.debug('syncPlaylistContents, attempt', _attempt);

  Trackcache.queryTracks(db, splaylistcache, playlist, {}, tracks => {
    if (tracks === null) {
      Reporting.reportSync('failure', 'failed-query');
      return;
    }

    console.debug('lock', playlist.title);
    playlistIsUpdating[playlist.remoteId] = true;
    console.debug(playlist.title, 'found', tracks.length);
    if (tracks.length > 0) {
      console.debug('first is', tracks[0]);
    }
    if (tracks.length > 1000) {
      console.warn('attempting to sync over 1000 tracks; only first 1k will sync');
    }

    const desiredTracks = tracks.slice(0, 1000);

    Gm.setPlaylistContents(db, user, playlist.remoteId, desiredTracks, response => {
    // Gmoauth.setPlaylistContents(db, user, playlist.remoteId, desiredTracks, splaylistcache, response => {
      if (response !== null) {
        // large updates seem to only apply partway sometimes.
        // retrying like this seems to make even 1k playlists eventually consistent.
        if (_attempt < 2) {
          Reporting.reportSync('retry', `retry-${_attempt}`);
          console.debug('not a 0-track add; retrying syncPlaylistContents', response);
          setTimeout(syncPlaylistContents, 10000 * (_attempt + 1), playlist, _attempt + 1);
        } else {
          Reporting.reportSync('failure', 'gave-up');
          console.warn('giving up on syncPlaylistContents!', response);
          // Never has the need for promises been so clear.
          Gm.setPlaylistOrder(db, user, playlist, orderResponse => {
            console.debug('reorder response', orderResponse);
            console.debug('unlock', playlist.title);
            playlistIsUpdating[playlist.remoteId] = false;
          }, err => {
            Reporting.reportSync('failure', 'failed-reorder');
            console.error('failed to reorder playlist', playlist.title, err);
            Reporting.Raven.captureMessage('sync setPlaylistOrder', {
              tags: {playlistId: playlist.remoteId},
              extra: {playlist, err},
            });
            console.debug('unlock', playlist.title);
            playlistIsUpdating[playlist.remoteId] = false;
          });
        }
      } else {
        Gm.setPlaylistOrder(db, user, playlist, orderResponse => {
          Reporting.reportSync('success', `success-${_attempt}`);
          console.debug('reorder response', orderResponse);
          console.debug('unlock', playlist.title);
          playlistIsUpdating[playlist.remoteId] = false;
        }, err => {
          Reporting.reportSync('failure', 'failed-reorder');
          console.error('failed to reorder playlist', playlist.title, err);
          Reporting.Raven.captureMessage('sync setPlaylistOrder', {
            tags: {playlistId: playlist.remoteId},
            extra: {playlist, err},
          });
          console.debug('unlock', playlist.title);
          playlistIsUpdating[playlist.remoteId] = false;
        });
      }
    }, err => {
      Reporting.reportSync('failure', 'failed-set');
      console.error('failed to sync playlist', playlist.title, err);
      Reporting.Raven.captureMessage('sync setPlaylistContents', {
        tags: {playlistId: playlist.remoteId},
        extra: {playlist, err},
      });
      console.debug('unlock', playlist.title);
      playlistIsUpdating[playlist.remoteId] = false;
    });
  });
}

function getDescription(playlist, splaylistcache, playlists) {
  const rulesRepr = Playlist.toString(playlist, playlists, splaylistcache);
  return `Synced ${new Date().toLocaleString()} by Autoplaylists for Google Music™ to contain: ${rulesRepr}.`;
}

function getPlaylistMutations(playlist, splaylistcache, playlists) {
  const description = getDescription(playlist, splaylistcache, playlists);
  const update = Gmoauth.buildPlaylistUpdates([{id: playlist.remoteId, name: playlist.title, description}]);
  return update;
}


function getEntryMutations(playlist, splaylistcache, callback) {
  console.log('cache', playlist.remoteId, splaylistcache);
  let currentEntries = {};
  if (playlist.remoteId in splaylistcache.splaylists) {
    currentEntries = splaylistcache.splaylists[playlist.remoteId].entries;
  } else {
    console.warn('playlist.remoteId', playlist.remoteId, 'not yet cached; assuming empty');
  }

  // We'll make three kinds of mutations:
  //   1) delete tracks we don't want (that aren't currently playing)
  //   2) add tracks we're missing
  //   3) reorder the resulting tracks
  // These can all be batched.
  // As opposed to a simpler delete-all+add-all approach, this:
  //   * reduces our request sizes and the work for Google
  //   * avoids clearing out tracks that are currently playing that we don't know of yet

  const db = dbs[playlist.userId];
  const mutations = [];
  const desiredOrdering = [];
  let tracksToAdd;
  let tracksToDelete;
  let deleteIdCandidates;
  let entriesToKeep;

  new Promise(resolve => {
    Trackcache.queryTracks(db, splaylistcache, playlist, {}, resolve);
  }).then(tracks => {
    const desiredTracks = tracks.slice(0, 1000);

    // We'll reorder these later.
    tracksToAdd = new Set(desiredTracks.map(t => t.id));
    console.log('query found', tracksToAdd);

    tracksToDelete = {};
    entriesToKeep = {};
    for (const entryId in currentEntries) {
      const remoteTrackId = currentEntries[entryId];

      if (tracksToAdd.has(remoteTrackId)) {
        console.log('no need to add', remoteTrackId);
        tracksToAdd.delete(remoteTrackId);
        entriesToKeep[remoteTrackId] = entryId;
      } else {
        // This assumes that there are no duplicates in the remote, which will probably break eventually.
        console.log('want to delete', entryId);
        tracksToDelete[remoteTrackId] = entryId;
      }
    }

    // Don't delete tracks that are currently playing.
    deleteIdCandidates = Object.keys(tracksToDelete);
    const track = db.getSchema().table('Track');
    return db.select().from(track).where(
      // We don't know if these entries name a library or store id.
      Lf.op.or(track.id.in(deleteIdCandidates),
               track.storeId.in(deleteIdCandidates))
    ).exec();
  }).then(rows => {
    const nowMillis = new Date().getTime();
    const delayMillis = 0;

    rows.forEach(row => {
      const lastPlayed = delayMillis + (row.lastPlayed / 1000);
      const playtime = nowMillis - row.durationMillis;
      if (lastPlayed > playtime) {
        console.info('not deleting', row, 'since it may be playing.', lastPlayed, playtime);
        if (row.id in tracksToDelete) {
          delete tracksToDelete[row.id];
        } else {
          delete tracksToDelete[row.storeId];
        }
      }
    });

    const trackIdsRemaining = Object.keys(entriesToKeep);
    for (const id of tracksToAdd) {
      trackIdsRemaining.push(id);
    }

    console.log('remaining (to order)', trackIdsRemaining);

    return new Promise(resolve => {
      Trackcache.orderTracks(db, playlist, trackIdsRemaining, resolve);
    });
  }).then(orderedTracks => {
    console.log('to add', tracksToAdd);
    console.log('to keep', entriesToKeep);
    console.log('to delete', tracksToDelete);
    console.log('in order', orderedTracks);

    const appends = Gmoauth.buildEntryAppends(playlist.remoteId, Array.from(tracksToAdd));
    const appendsByTrackId = {};
    for (let i = 0; i < appends.length; i++) {
      const append = appends[i];
      mutations.push(append);
      appendsByTrackId[append.create.trackId] = append.create;
    }
    const deletes = Gmoauth.buildEntryDeletes(Object.values(tracksToDelete));
    for (let i = 0; i < deletes.length; i++) {
      mutations.push(deletes[i]);
    }

    for (let i = 0; i < orderedTracks.length; i++) {
      const track = orderedTracks[i];
      let clientId;
      let type;
      let entryId;
      let append;

      if (track.id in entriesToKeep || track.storeId in entriesToKeep) {
        type = 'existing';
        clientId = uuidV1();
        entryId = entriesToKeep[track.id] || entriesToKeep[track.storeId];
      } else {
        console.log('look up', track, 'in', appendsByTrackId);
        // We only build appends with library id.
        append = appendsByTrackId[track.id];
        type = 'append';
        clientId = append.clientId;
      }
      desiredOrdering.push({type, clientId, entryId, append});
    }

    const reorderings = [];
    for (let i = 0; i < desiredOrdering.length; i++) {
      const ordering = desiredOrdering[i];
      console.log(i, ordering);
      let target;
      if (ordering.type === 'existing') {
        target = {id: ordering.entryId, clientId: ordering.clientId};
        reorderings.push(target);
      } else {
        target = ordering.append;
      }

      target.relativePositionIdType = 2;
      if (i > 0) {
        target.precedingEntryId = desiredOrdering[i - 1].clientId;
        console.log('set preceding', target);
      }
      if (i < desiredOrdering.length - 1) {
        target.followingEntryId = desiredOrdering[i + 1].clientId;
        console.log('set following', target);
      }
    }

    console.log('final reorderings', reorderings);
    const reorders = Gmoauth.buildEntryReorders(reorderings);
    for (let i = 0; i < reorders.length; i++) {
      mutations.push(reorders[i]);
    }
    console.log('mutations', mutations);
    callback(mutations);
  });
}

function syncPlaylist(playlist, playlists) {
  // Sync a playlist's metadata and contents.
  // A remote playlist will be created if one does not exist yet.
  console.log('syncPlaylist', playlist.title);
  const user = users[playlist.userId];
  const splaylistcache = splaylistcaches[playlist.userId];

  Storage.getNewSyncEnabled(newSyncEnabled => {
    if (!('remoteId' in playlist)) {
      // The remote playlist doesn't exist yet.
      if (newSyncEnabled) {
        const add = Gmoauth.buildPlaylistAdd(playlist.title, getDescription(playlist, splaylistcache, playlists));
        Gmoauth.runPlaylistMutations(user, [add], response => {
          postCreate(playlist, response);
        });
      } else {
        Gm.createRemotePlaylist(user, playlist.title, remoteId => {
          legacyPostCreate(playlist, remoteId);
        });
      }
    } else {
      if (newSyncEnabled) {
        syncSplaylistcache(playlist.userId).then(() => {
          // Unfortunately playlist and entry updates can't be batched.
          const playlistMutations = getPlaylistMutations(playlist, splaylistcache, playlists);
          Gmoauth.runPlaylistMutations(user, playlistMutations, response => {
            console.log('update res', response);
          });

          getEntryMutations(playlist, splaylistcache, mutations => {
            Gmoauth.runEntryMutations(user, mutations, response => {
              console.log('entry res', response);
            });
          });
        });
      } else {
        Gm.updatePlaylist(user, playlist.remoteId, playlist.title, playlist, playlists, splaylistcache, () => {
          syncPlaylistContents(playlist);
        });
      }
    }
  });
}

function postCreate(playlist, response) {
  console.log('postCreate', response);
  const remoteId = response.mutate_response[0].id;
  legacyPostCreate(playlist, remoteId);
}

function legacyPostCreate(playlist, remoteId) {
  console.log('created remote playlist', remoteId);
  const playlistToSave = JSON.parse(JSON.stringify(playlist));
  playlistToSave.remoteId = remoteId;

  Storage.savePlaylist(playlistToSave, () => {
    // nothing else to do. listener will see the change and recall.
    console.debug('wrote remote id');
  });
}

function syncEntryMutations(hasFullVersion, splaylistcache, user, playlists) {
  const entryMutations = [];
  let callbacksRemaining = playlists.length;

  function processMutations(mutations) {
    for (let j = 0; j < mutations.length; j++) {
      entryMutations.push(mutations[j]);
    }
    callbacksRemaining--;

    if (callbacksRemaining <= 0) {
      Gmoauth.runEntryMutations(user, entryMutations, response => {
        console.log('combined entry res', response);
      });
    }
  }

  for (let i = 0; i < playlists.length; i++) {
    const playlist = playlists[i];

    if (i > 0 && !hasFullVersion) {
      console.info('skipping sync of locked playlist', playlist.title);
      callbacksRemaining--;
      continue;
    }

    getEntryMutations(playlist, splaylistcache, processMutations);
  }
}

function syncPlaylistMutations(hasFullVersion, splaylistcache, user, playlists) {
  const playlistMutations = [];
  let callbacksRemaining = playlists.length;

  function processMutations(mutations) {
    for (let j = 0; j < mutations.length; j++) {
      playlistMutations.push(mutations[j]);
    }
    callbacksRemaining--;

    if (callbacksRemaining <= 0) {
      Gmoauth.runPlaylistMutations(user, playlistMutations, response => {
        console.log('combined playlist res', response);
      });
    }
  }

  for (let i = 0; i < playlists.length; i++) {
    const playlist = playlists[i];

    if (i > 0 && !hasFullVersion) {
      console.info('skipping sync of locked playlist', playlist.title);
      callbacksRemaining--;
      continue;
    }

    processMutations(getPlaylistMutations(playlist, splaylistcache, playlists));
  }
}

function syncPlaylists(userId) {
  console.log('syncPlaylists', userId);
  const db = dbs[userId];
  const splaylistcache = splaylistcaches[userId];
  const user = users[userId];

  if (!db) {
    console.warn('refusing syncPlaylists because db is not init');

    Reporting.Raven.captureMessage('refusing forceUpdate because db is not init', {
      level: 'warning',
      extra: {users},
    });
    return;
  }

  License.hasFullVersion(false, hasFullVersion => {
    Storage.getPlaylistsForUser(userId, playlists => {
      Storage.getNewSyncEnabled(newSyncEnabled => {
        if (newSyncEnabled) {
          // These don't need to be ordered since the playlists we're modifying should exist already.
          syncEntryMutations(hasFullVersion, splaylistcache, user, playlists);
          syncPlaylistMutations(hasFullVersion, splaylistcache, user, playlists);
        } else {
          for (let i = 0; i < playlists.length; i++) {
            const playlist = playlists[i];

            if (i > 0 && !hasFullVersion) {
              console.info('skipping sync of locked playlist', playlist.title);
              continue;
            }

            // This locking prevents two things:
            //   * slow periodic syncs from stepping on later periodic syncs
            //   * periodic syncs from stepping on manual syncs
            if (playlistIsUpdating[playlist.remoteId]) {
              console.warn('skipping sync since playlist is being updated:', playlist.title);
            } else {
              syncPlaylist(playlist, playlists);
            }
          }
        }
      });
    });
  });
}

function syncSplaylistcache(userId) {
  // Promise nothing when the cache is updated.
  const splaylistcache = splaylistcaches[userId];

  const playlistsP = new Promise(resolve => {
    Storage.getPlaylistsForUser(userId, resolve);
  });

  const deletedIdsP = playlistsP.then(playlists =>
    new Promise(resolve => {
      Splaylistcache.sync(splaylistcache, users[userId], playlists, resolve);
    })
  );

  return Promise.all([playlistsP, deletedIdsP])
  .then(params => {
    const playlists = params[0];
    const deletedIds = params[1];
    for (const deletedId of deletedIds) {
      Playlist.deleteAllReferences('P' + deletedId, playlists);
      for (let i = 0; i < playlists.length; i++) {
        // FIXME this sucks?
        Storage.savePlaylist(playlists[i], () => {});
      }
    }
  });
}

function initSyncSchedule() {
  // Set the periodic sync schedule based on the last periodic sync.
  // This may also sync immediately if we're overdue for a sync.
  // now >= last-sync + sync-period: sync immediately. Next sync at now + sync-period.
  // now < last-sync + sync-period: don't sync. Next sync at last-sync + sync-period

  if (syncsHaveStarted) {
    console.log("request to init syncs, but they're already started");
    return;
  }

  Storage.getLastPSync(lastPSync => {
    console.log('initSyncSchedule. lastPSync was', new Date(lastPSync));
    Storage.getSyncMs(initSyncMs => {
      console.info('sync interval initially', initSyncMs);
      const nextExpectedSync = new Date(lastPSync + initSyncMs);
      const now = new Date();
      let startDelayId = null;

      if (nextExpectedSync < now) {
        // We're overdue; sync now.
        console.info('sync overdue; starting periodic syncs now');
        startPeriodicSyncs();
      } else {
        // The next sync is in the future.
        const startDelay = nextExpectedSync.getTime() - now.getTime();
        console.info(`delaying syncs for ~${Math.round(startDelay / 1000 / 60)} minutes`);
        startDelayId = setTimeout(startPeriodicSyncs, startDelay);

        // Sync immediately if the startDelay if the sync period changes.
        // This isn't ideal, but it's much simpler than changing the delay.
        Storage.addSyncMsChangeListener(change => { // eslint-disable-line no-unused-vars
          clearTimeout(startDelayId);
          if (!syncsHaveStarted) {
            console.info('sync period updated during delay; syncing now');
            startPeriodicSyncs();
          }
        });
      }
    });
  });
}

function startPeriodicSyncs() {
  if (syncsHaveStarted) {
    console.log("request to init syncs, but they're already started");
    return;
  }

  syncsHaveStarted = true;

  Storage.getSyncMs(initSyncMs => {
    let syncIntervalId = null;

    // Don't sync at 0 period or more often than one minute.
    // (The latter should also be prevented by the ui.)
    if (initSyncMs >= 60 * 1000) {
      periodicUpdate();
      syncIntervalId = setInterval(periodicUpdate, initSyncMs);
    }

    // Handle updates to the sync period.
    Storage.addSyncMsChangeListener(change => {
      const oldSyncMs = change.oldValue;
      const syncMs = change.newValue;
      console.info('sync interval changing to', syncMs);

      if (syncIntervalId !== null) {
        clearInterval(syncIntervalId);
      }

      syncIntervalId = null;
      if (syncMs >= 60 * 1000) {
        syncIntervalId = setInterval(periodicUpdate, syncMs);
        if (oldSyncMs === 0) {
          console.info('syncs turning back on; syncing now');
          periodicUpdate();
        }
      }
    });
  });
}


function periodicUpdate() {
  const now = new Date();
  Storage.setLastPSync(now.getTime(), () => {
    console.log('set lastPSync to', now);
  });

  for (const userId in users) {
    console.log('periodic update for', userId);

    syncSplaylistcache(userId)
    .then(() => {
      if (dbs[userId]) {
        diffUpdateTrackcache(userId, dbs[userId], response => {
          console.debug('periodic diffUpdate:', response.success, response);
          syncPlaylists(userId);
        });
      } else {
        // Retry to init the library.
        console.warn('db not init at periodic sync');
        Reporting.Raven.captureMessage('db not init at periodic sync', {
          level: 'warning',
          extra: {users},
        });
        initLibrary(userId, () => null);
      }
    });
  }
}

function initLibrary(userId, callback) {
  // Initialize our cache from Google's indexeddb, or fall back to a differential update from time 0.
  // Callback nothing when finished.
  Track.resetRandomCache();
  Trackcache.openDb(userId, db => {
    const message = {action: 'getLocalTracks', userId};
    chrome.tabs.sendMessage(users[userId].tabId, message, response => {
      if (chrome.extension.lastError || response === null || response.gtracks === null ||
          response.gtracks.length === 0 || response.timestamp === null) {
        console.warn('local idb not helpful; falling back to diffUpdate(0).', response, chrome.extension.lastError);
        diffUpdateTrackcache(userId, db, diffResponse => {
          if (diffResponse.success) {
            dbs[userId] = db;
          } else {
            console.warn('failed to init library after diffupdate fallback');
            Reporting.Raven.captureMessage('failed to init library', {
              extra: {response, lastError: chrome.extension.lastError},
              tags: {hadToFallback: true},
            });
          }
          callback();
        }, 0);
      } else {
        console.log('got idb gtracks:', response.gtracks.length);
        const tracks = response.gtracks.map(Track.fromJsproto);
        Trackcache.upsertTracks(db, userId, tracks, () => {
          diffUpdateTrackcache(userId, db, diffResponse => {
            if (diffResponse.success) {
              dbs[userId] = db;
            } else {
              console.warn('failed to init library after successful idb read');
              Reporting.Raven.captureMessage('failed to init library', {
                extra: {response},
                tags: {hadToFallback: false},
              });
            }
            callback();
          }, response.timestamp);
        });
      }
    });
  });
}


function main() {
  Storage.getNewSyncEnabled(newSyncEnabled => {
    if (newSyncEnabled) {
      console.info('new sync is enabled!');
    } else {
      console.log('using legacy sync');
    }
  });

  chrome.identity.getProfileUserInfo(userInfo => {
    primaryGaiaId = userInfo.id;
  });

  Storage.addPlaylistChangeListener(change => {
    const hasOld = 'oldValue' in change;
    const hasNew = 'newValue' in change;

    let operation;
    let userId;
    if (hasOld && !hasNew) {
      operation = 'delete';
      userId = change.oldValue.userId;
    } else {
      operation = 'create-or-update';
      userId = change.newValue.userId;
    }

    Storage.getPlaylistsForUser(userId, playlists => {
      if (operation === 'delete') {
        Gm.deleteRemotePlaylist(users[userId], change.oldValue.remoteId, () => null);

        Playlist.deleteAllReferences(change.oldValue.localId, playlists);
        for (let i = 0; i < playlists.length; i++) {
          Storage.savePlaylist(playlists[i], () => {});
        }
      } else {
        syncPlaylist(change.newValue, playlists);
      }
    });
  });

  chrome.pageAction.onClicked.addListener(tab => {
    chrome.notifications.clear('zeroPlaylists');
    const userId = userIdForTabId(tab.id);
    if (userId) {
      chrome.identity.getAuthToken({interactive: false}, token => {
        if (chrome.runtime.lastError) {
          console.info('not authorized; asking for auth', chrome.runtime.lastError);
          chrome.identity.getAuthToken({interactive: true}, token2 => {
            if (!(chrome.runtime.lastError)) {
              console.info('got auth', token2);
              const qstring = Qs.stringify({userId: userIdForTabId(tab.id)});
              const url = chrome.extension.getURL('html/playlists.html');
              Chrometools.focusOrCreateExtensionTab(`${url}?${qstring}`);
            }
          });
        } else {
          console.info('got token', token);
          const qstring = Qs.stringify({userId: userIdForTabId(tab.id)});
          const url = chrome.extension.getURL('html/playlists.html');
          Chrometools.focusOrCreateExtensionTab(`${url}?${qstring}`);
        }
      });
    } else {
      // Only the primary user is ever put into the users array.
      Reporting.Raven.captureMessage('multiuser page action click', {
        level: 'warning',
        extra: {userId, primaryGaiaId, users},
      });
      Reporting.reportHit('multiuserPageActionClick');

      const url = chrome.extension.getURL('html/multi-user.html');
      Chrometools.focusOrCreateExtensionTab(url);
    }
  });

  chrome.notifications.onButtonClicked.addListener((notificationId, buttonIndex) => {
    if (notificationId === 'zeroPlaylists') {
      chrome.tabs.create({url: 'https://autoplaylists.simon.codes/#usage'});
      chrome.notifications.clear(notificationId);
      Reporting.reportHit('zeroPlaylistsHelpButton');
    } else {
      Reporting.Raven.captureMessage('unknown notificationId button click', {
        level: 'warning',
        extra: {notificationId, buttonIndex, users},
      });
    }
  });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // respond to manager / content script requests.

    if (request.action === 'forceUpdate') {
      if (!dbs[request.userId]) {
        console.warning('forceUpdate requested diffUpdate, but db not init for', request.userId);
        Reporting.Raven.captureMessage('forceUpdate requested diffUpdate, but db not init', {
          level: 'warning',
          extra: {request, users, dbs, syncsHaveStarted},
        });
      } else {
        console.log('forceupdate diffUpdate');
        diffUpdateTrackcache(request.userId, dbs[request.userId], response => {
          console.debug('forceupdate diffUpdate res:', response);
          syncPlaylists(request.userId);
        });
      }
    } else if (request.action === 'setXsrf') {
      console.info('updating xt:', JSON.stringify(request));
      users[request.userId].xt = request.xt;

      if (!dbs[request.userId]) {
        console.warning('setXsrf requested diffUpdate, but db not init for', request.userId);
        Reporting.Raven.captureMessage('setXsrf requested diffUpdate, but db not init', {
          level: 'warning',
          extra: {request, users, dbs, syncsHaveStarted},
        });
      } else {
        console.log('xsrf diffUpdate');
        diffUpdateTrackcache(request.userId, dbs[request.userId], response => {
          console.debug('xsrf diffUpdate response', response);
          syncPlaylists(request.userId);
        });
      }
    } else if (request.action === 'showPageAction') {
      if (!(request.userId)) {
        console.warn('received falsey user id from page action');
        Reporting.Raven.captureMessage('received falsey user id from page action', {
          level: 'warning',
          extra: {user_id: request.userId},
        });

        return false;
      }

      // In the case that an existing tab/index was changed to a new user,
      // remove the old entry.
      for (const userId in users) {
        if (users[userId].tabId === sender.tab.id ||
            users[userId].userIndex === request.userIndex) {
          delete users[userId];
        }
      }

      let tier = 'free';
      if (request.tier === 2) {
        tier = 'aa';
      }

      users[request.userId] = {userIndex: request.userIndex, tabId: sender.tab.id, xt: request.xt, tier};
      console.log('see user', request.userId, users);
      if (request.gaiaId !== primaryGaiaId) {
        console.warn('user is not the primary user');
        chrome.pageAction.show(sender.tab.id);
        return;
      }

      License.hasFullVersion(false, hasFullVersion => { console.log('precached license status:', hasFullVersion); });

      // FIXME store this in sync storage and include it in context?
      // That'd mean we wouldn't get it immediately, though, so maybe this is better.
      Reporting.Raven.setTagsContext({tier: request.tier});
      Reporting.GATracker.set('dimension3', request.tier);
      Reporting.reportHit('showPageAction');

      // init the caches.
      initLibrary(request.userId, () => {
        initSyncSchedule();
      });
      splaylistcaches[request.userId] = Splaylistcache.open();
      syncSplaylistcache(request.userId);

      chrome.pageAction.show(sender.tab.id);

      Storage.getPlaylistsForUser(request.userId, playlists => {
        if (playlists.length === 0) {
          chrome.notifications.create('zeroPlaylists', {
            type: 'basic',
            title: 'Create your first autoplaylist!',
            message: "To get started, click the extension's page action (to the right of the url bar).",
            iconUrl: 'icon-128.png',
            buttons: [{title: "Click here if you don't see the page action.", iconUrl: 'question_mark.svg'}],
          });
          Reporting.reportHit('zeroPlaylistsNotification');
        }
      });
    } else if (request.action === 'query') {
      const db = dbs[request.playlist.userId];
      const splaylistcache = splaylistcaches[request.playlist.userId];
      Trackcache.queryTracks(db, splaylistcache, request.playlist, {}, tracks => {
        sendResponse({tracks});
      });
      return true; // wait for async response
    } else if (request.action === 'debugQuery') {
      const query = eval(request.query);

      query.exec()
      .then(rows => {
        sendResponse({tracks: rows});
      })
      .catch(e => {
        console.warn(JSON.stringify(e));
      });
      return true;
    } else if (request.action === 'getContext') {
      Context.get(sendResponse);
      return true;
    } else if (request.action === 'getSplaylistcache') {
      sendResponse(splaylistcaches[request.userId]);
      return;
    } else {
      console.warn('received unknown request', request);
      Reporting.Raven.captureMessage('received unknown request', {
        level: 'warning',
        extra: {request},
      });
    }
  });

  Reporting.reportHit('load');
}

Storage.handleMigrations(main);
