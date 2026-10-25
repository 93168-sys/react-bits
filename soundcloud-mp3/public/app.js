(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var form = $('form');
  var input = $('url');
  var goBtn = $('go');
  var message = $('message');

  var trackCard = $('card');
  var art = $('art');
  var titleEl = $('title');
  var artistEl = $('artist');
  var durationEl = $('duration');
  var download = $('download');

  var playlistCard = $('playlist');
  var plArt = $('pl-art');
  var plTitle = $('pl-title');
  var plSub = $('pl-sub');
  var zipBtn = $('zip-btn');
  var zipCancel = $('zip-cancel');
  var progress = $('progress');
  var bar = $('bar');
  var progressText = $('progress-text');
  var trackList = $('tracks');

  var latest = 0; // which lookup is the current one
  var job = null; // the running "download all" job, if any
  var currentPlaylist = null; // the playlist on screen

  function showMessage(text, isWarn) {
    message.textContent = text;
    message.classList.toggle('warn', Boolean(isWarn));
    message.hidden = false;
  }

  function formatDuration(ms) {
    if (!ms) return '';
    var total = Math.round(ms / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = String(total % 60).padStart(2, '0');
    return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + s : m + ':' + s;
  }

  function setArt(img, src) {
    if (src) {
      img.src = src;
      img.hidden = false;
    } else {
      img.hidden = true;
    }
  }
  art.addEventListener('error', function () { art.hidden = true; });
  plArt.addEventListener('error', function () { plArt.hidden = true; });

  function cancelJob() {
    if (job) job.abort();
  }

  function hideResults() {
    cancelJob();
    message.hidden = true;
    trackCard.hidden = true;
    playlistCard.hidden = true;
  }

  // --- single track -------------------------------------------------------

  function showTrack(info, url) {
    titleEl.textContent = info.title;
    artistEl.textContent = info.artist || '';
    durationEl.textContent = formatDuration(info.durationMs);
    setArt(art, info.artwork);
    if (info.downloadable) {
      download.href = '/api/download?url=' + encodeURIComponent(url);
      download.textContent = 'Download MP3';
      download.hidden = false;
    } else {
      download.hidden = true;
      showMessage(info.reason || 'This track cannot be downloaded.', true);
    }
    trackCard.hidden = false;
  }

  download.addEventListener('click', function () {
    download.textContent = 'Starting download...';
    setTimeout(function () { download.textContent = 'Download MP3'; }, 4000);
  });

  // --- playlist -----------------------------------------------------------

  function showPlaylist(info) {
    var downloadable = info.tracks.filter(function (t) { return t.downloadable; });

    plTitle.textContent = info.title;
    plSub.textContent =
      (info.artist ? info.artist + ' · ' : '') +
      info.tracks.length + (info.tracks.length === 1 ? ' track' : ' tracks');
    setArt(plArt, info.artwork);

    trackList.textContent = '';
    info.tracks.forEach(function (t) {
      var li = document.createElement('li');

      var num = document.createElement('span');
      num.className = 'num';
      num.textContent = t.position;

      var name = document.createElement('span');
      name.className = 'tname' + (t.downloadable ? '' : ' off');
      name.textContent = t.title;
      var small = document.createElement('small');
      small.textContent = t.downloadable ? t.artist || '' : t.reason || 'Not available';
      name.appendChild(small);

      var dur = document.createElement('span');
      dur.className = 'dur';
      dur.textContent = formatDuration(t.durationMs);

      li.append(num, name, dur);
      if (t.downloadable) {
        var link = document.createElement('a');
        link.className = 'mini';
        link.href = '/api/download?id=' + encodeURIComponent(t.id);
        link.setAttribute('download', '');
        link.textContent = 'MP3';
        link.setAttribute('aria-label', 'Download ' + t.title);
        li.appendChild(link);
      }
      trackList.appendChild(li);
    });

    zipBtn.disabled = downloadable.length === 0;
    zipBtn.textContent =
      downloadable.length === 0
        ? 'Nothing to download'
        : 'Download all as ZIP (' + downloadable.length + ')';
    zipBtn.hidden = false;
    zipCancel.hidden = true;
    progress.hidden = true;
    playlistCard.hidden = false;

    var notes = [];
    if (info.truncated) {
      notes.push('This playlist has ' + info.totalTracks + ' tracks. Only the first ' + info.tracks.length + ' are shown.');
    }
    var blocked = info.tracks.length - downloadable.length;
    if (blocked > 0) {
      notes.push(blocked + (blocked === 1 ? ' track cannot' : ' tracks cannot') + ' be downloaded and will be skipped.');
    }
    if (notes.length) showMessage(notes.join(' '), true);

    currentPlaylist = info;
  }

  function setProgress(done, total, text) {
    bar.max = total;
    bar.value = done;
    progressText.textContent = text;
  }

  function fetchTrackBytes(track, signal) {
    var attempt = 0;
    function once() {
      attempt++;
      return fetch('/api/download?id=' + encodeURIComponent(track.id), { signal: signal })
        .then(function (res) {
          if (!res.ok) throw new Error('status ' + res.status);
          return res.arrayBuffer();
        })
        .then(function (buf) {
          if (buf.byteLength === 0) throw new Error('empty');
          return new Uint8Array(buf);
        })
        .catch(function (err) {
          if (signal.aborted || attempt >= 2) throw err;
          return once();
        });
    }
    return once();
  }

  function saveBlob(blob, filename) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
  }

  function pad(n, width) {
    return String(n).padStart(width, '0');
  }

  function startZip() {
    var info = currentPlaylist;
    if (!info || job) return;
    var items = info.tracks.filter(function (t) { return t.downloadable; });
    if (items.length === 0) return;

    var controller = new AbortController();
    job = controller;
    message.hidden = true;
    zipBtn.hidden = true;
    zipCancel.hidden = false;
    progress.hidden = false;

    var zip = MiniZip.createZip();
    var skipped = [];
    var width = String(info.tracks.length).length;
    var chain = Promise.resolve();

    items.forEach(function (track, i) {
      chain = chain.then(function () {
        setProgress(i, items.length, 'Downloading ' + (i + 1) + ' of ' + items.length + ': ' + track.title);
        return fetchTrackBytes(track, controller.signal).then(
          function (bytes) {
            zip.add(pad(track.position, width) + ' - ' + track.filename, bytes);
          },
          function (err) {
            if (controller.signal.aborted) throw err;
            skipped.push(track.title);
          }
        );
      });
    });

    chain
      .then(function () {
        if (zip.count === 0) throw new Error('None of the tracks could be downloaded. Try again in a moment.');
        setProgress(items.length, items.length, 'Building the ZIP...');
        saveBlob(zip.finish(), info.zipName);
        if (skipped.length) {
          showMessage(
            'Saved ' + zip.count + ' of ' + items.length + ' tracks. Could not download: ' + skipped.join(', ') + '.',
            true
          );
        } else {
          setProgress(items.length, items.length, 'Done. ' + zip.count + ' tracks saved in ' + info.zipName + '.');
        }
      })
      .catch(function (err) {
        if (controller.signal.aborted) {
          setProgress(0, 1, '');
          progress.hidden = true;
          showMessage('Cancelled. Nothing was saved.', true);
        } else {
          showMessage(err.message || 'Something went wrong. Try again.');
        }
      })
      .then(function () {
        job = null;
        zipBtn.hidden = false;
        zipCancel.hidden = true;
      });
  }

  zipBtn.addEventListener('click', startZip);
  zipCancel.addEventListener('click', cancelJob);

  window.addEventListener('beforeunload', function (event) {
    if (job) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  // --- lookup -------------------------------------------------------------

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    var url = input.value.trim();
    hideResults();
    if (!url) {
      showMessage('Paste a SoundCloud track or playlist link first.');
      return;
    }

    var id = ++latest;
    goBtn.disabled = true;
    goBtn.textContent = 'Looking up...';

    fetch('/api/info?url=' + encodeURIComponent(url))
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
          return data;
        });
      })
      .then(function (info) {
        if (id !== latest) return;
        if (info.kind === 'playlist') showPlaylist(info);
        else showTrack(info, url);
      })
      .catch(function (err) {
        if (id === latest) showMessage(err.message || 'Something went wrong. Try again.');
      })
      .then(function () {
        if (id === latest) {
          goBtn.disabled = false;
          goBtn.textContent = 'Get MP3';
        }
      });
  });

  // Pasting a link starts the lookup straight away.
  input.addEventListener('paste', function () {
    setTimeout(function () {
      if (input.value.trim()) form.requestSubmit();
    }, 0);
  });
})();
