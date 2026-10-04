// Запись озвучки поверх видео
const Voiceover = {
  stream: null,
  rec: null,
  muteProject: true,
  countdown: true,
  voiceFx: null,   // голос, который применится к записи (VOICE_FX)

  async open() {
    if (!store.p) return;
    if (Player.playing) Player.pause();
    const body = h(`<div class="vo">
      <div class="vo-row"><label>Микрофон</label><select class="select vo-dev"></select></div>
      <div class="vo-meter"><i></i></div>
      <div class="vo-opts">
        <label class="check"><input type="checkbox" class="vo-mute" ${this.muteProject ? 'checked' : ''}><span></span>Приглушить звук проекта</label>
        <label class="check"><input type="checkbox" class="vo-cd" ${this.countdown ? 'checked' : ''}><span></span>Отсчёт 3 секунды</label>
      </div>
      <div class="vo-voice"><label>Голос</label></div>
      <div class="vo-main">
        <div class="vo-time">00:00</div>
        <button class="vo-btn" title="Начать запись"><i></i></button>
        <div class="vo-hint">Запись начнётся с позиции курсора: <b>${fmtTC(store.time, store.p.fps)}</b></div>
      </div>
    </div>`);
    const dlg = modal({ title: 'Озвучка', body, width: 470, cls: 'rec-modal', onClose: () => this.close() });
    this.dlg = dlg;
    this.ui = body;
    $('.vo-mute', body).onchange = (e) => this.muteProject = e.target.checked;
    $('.vo-cd', body).onchange = (e) => this.countdown = e.target.checked;
    $('.vo-voice', body).appendChild(VoiceFx.grid(this.voiceFx, (id) => { this.voiceFx = id; }));
    $('.vo-btn', body).onclick = () => this.rec ? this.stop() : this.start();
    const sel = $('.vo-dev', body);
    sel.onchange = () => this.openStream(sel.value);
    await this.openStream();
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
      const cur = this.stream && this.stream.getAudioTracks()[0].getSettings().deviceId;
      sel.innerHTML = devs.map(d => `<option value="${esc(d.deviceId)}" ${d.deviceId === cur ? 'selected' : ''}>${esc(d.label || 'Микрофон')}</option>`).join('');
    } catch { }
  },

  async openStream(deviceId) {
    this.closeStream();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (e) {
      toast('Нет доступа к микрофону: ' + e.message, 'error', 5000);
      return;
    }
    const ac = Player.audio();
    ac.resume();
    this.src = ac.createMediaStreamSource(this.stream);
    this.an = ac.createAnalyser();
    this.an.fftSize = 1024;
    this.src.connect(this.an);
    const buf = new Float32Array(this.an.fftSize);
    const bar = $('.vo-meter i', this.ui);
    const tick = () => {
      if (!this.an) return;
      this.an.getFloatTimeDomainData(buf);
      let pk = 0; for (const v of buf) pk = Math.max(pk, Math.abs(v));
      const db = 20 * Math.log10(pk + 1e-6);
      bar.style.width = clamp((db + 60) / 60 * 100, 0, 100) + '%';
      bar.classList.toggle('hot', db > -3);
      this.meterRaf = requestAnimationFrame(tick);
    };
    tick();
  },
  closeStream() {
    cancelAnimationFrame(this.meterRaf);
    if (this.src) try { this.src.disconnect(); } catch { }
    this.an = null; this.src = null;
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    this.stream = null;
  },

  async start() {
    if (!this.stream) { await this.openStream($('.vo-dev', this.ui).value); if (!this.stream) return; }
    const btn = $('.vo-btn', this.ui);
    btn.disabled = true;
    if (this.countdown) {
      const big = $('.vo-time', this.ui);
      for (let i = 3; i > 0; i--) {
        big.textContent = i; big.classList.add('cd');
        await new Promise(r => setTimeout(r, 1000));
        if (!this.ui.isConnected) return;
      }
      big.classList.remove('cd');
    }
    btn.disabled = false;
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    const rec = new MediaRecorder(this.stream, { mimeType: mime, audioBitsPerSecond: 192000 });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    this.rec = rec;
    this.chunks = chunks;
    this.startT = store.time;
    rec.onstart = () => {
      Timeline.rec = { start: this.startT, end: this.startT };
      Player.muted = this.muteProject;
      Player.noStop = true;
      Player.play();
      this.recStart = performance.now();
      const upd = () => {
        if (!this.rec) return;
        Timeline.rec.end = store.time;
        Timeline.render();
        $('.vo-time', this.ui).textContent = fmtDur((performance.now() - this.recStart) / 1000);
        this.recRaf = setTimeout(upd, 100);
      };
      upd();
    };
    rec.start(250);
    btn.classList.add('on');
    btn.title = 'Остановить запись';
    $('.vo-hint', this.ui).innerHTML = '<span class="rec-live">● Идёт запись</span> — нажмите, чтобы остановить';
    this.ui.closest('.modal-back').classList.add('recording');
  },

  async stop() {
    const rec = this.rec;
    if (!rec) return;
    this.rec = null;
    clearTimeout(this.recRaf);
    const done = new Promise(r => rec.onstop = r);
    rec.stop();
    Player.pause();
    Player.muted = false;
    Player.noStop = false;
    await done;
    Timeline.rec = null;
    const blob = new Blob(this.chunks, { type: rec.mimeType });
    $('.vo-btn', this.ui).classList.remove('on');
    $('.vo-hint', this.ui).textContent = 'Сохранение…';
    try {
      const buf = await blob.arrayBuffer();
      const file = await window.api.saveVoice(store.p.id, buf);
      const [m] = await Media.importPaths([file], { voice: true });
      if (m) {
        m.voice = true;
        const c = makeMediaClip(m, this.startT);
        if (this.voiceFx) c.voiceFx = this.voiceFx;
        const voiceTrack = store.p.tracks.find(t => t.kind === 'audio' && t.clips.some(x => { const mm = store.media(x.mediaId); return mm && mm.voice; }));
        store.place(c, 'audio', voiceTrack && voiceTrack.id);
        store.select(c.id);
        store.commit('voice');
        if (c.voiceFx) VoiceFx.ensure(c);
        toast('Озвучка добавлена на таймлайн', 'ok');
      }
    } catch (e) {
      toast('Не удалось сохранить запись: ' + e.message, 'error', 5000);
    }
    Timeline.render();
    this.dlg && this.dlg.close();
  },

  close() {
    if (this.rec) { this.stop(); return; }
    this.closeStream();
    this.dlg = null;
  },
};
