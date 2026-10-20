"""Tâches de fond (transcription, proxy, voix, rendu, IA) avec progression et journal d'évènements.
Les tâches lourdes (Whisper, Demucs, ECAPA, rendu) passent une par une dans la même file : elles se partagent la puce.
L'IA tourne à part (elle attend surtout le réseau)."""
import time, uuid, threading, traceback, queue

JOBS = {}
_heavy = queue.Queue()
_lock = threading.Lock()


class Cancelled(Exception):
    pass


class Job:
    def __init__(self, kind, project=None, label='', meta=None):
        self.id = 'j' + uuid.uuid4().hex[:10]
        self.kind, self.project, self.label = kind, project, label
        self.meta = meta or {}
        self.status = 'queued'
        self.progress = 0.0
        self.message = ''
        self.events = []
        self.result = None
        self.error = None
        self.created = time.time()
        self.cancelled = False
        self.proc = None            # sous-processus éventuel (rendu, claude -p), tué à l'annulation

    def emit(self, type_, **data):
        with _lock:
            self.events.append({'i': len(self.events), 'type': type_, 't': time.time(), **data})

    def step(self, progress=None, message=None):
        if self.cancelled: raise Cancelled()
        if progress is not None: self.progress = max(0.0, min(1.0, progress))
        if message is not None:
            self.message = message
            self.emit('log', text=message)

    def public(self, since=None):
        d = {k: getattr(self, k) for k in ('id', 'kind', 'project', 'label', 'status', 'progress', 'message', 'error',
                                           'created', 'meta')}
        d['result'] = self.result
        if since is not None:
            d['events'] = self.events[since:]
        return d


def _run(job, fn):
    job.status = 'running'
    job.emit('status', status='running')
    try:
        job.result = fn(job)
        job.status = 'done'
        job.progress = 1.0
    except Cancelled:
        job.status = 'cancelled'
    except Exception as e:                       # l'erreur part dans l'interface, avec la trace dans le terminal
        traceback.print_exc()
        job.status = 'error'
        job.error = f'{type(e).__name__}: {e}'
    job.emit('status', status=job.status, error=job.error)


def _worker():
    while True:
        job, fn = _heavy.get()
        if job.cancelled:
            job.status = 'cancelled'; continue
        _run(job, fn)


threading.Thread(target=_worker, daemon=True, name='heavy-jobs').start()


def submit(kind, fn, project=None, label='', heavy=True, meta=None):
    job = Job(kind, project, label, meta)
    JOBS[job.id] = job
    if heavy:
        _heavy.put((job, fn))
    else:
        threading.Thread(target=_run, args=(job, fn), daemon=True, name=f'job-{kind}').start()
    return job


def cancel(jid):
    job = JOBS.get(jid)
    if not job: return None
    job.cancelled = True
    if job.proc and job.proc.poll() is None:
        job.proc.terminate()
    if job.status == 'queued': job.status = 'cancelled'
    return job


def active(project=None):
    return [j.public() for j in sorted(JOBS.values(), key=lambda j: j.created)
            if (project is None or j.project == project) and (j.status in ('queued', 'running') or time.time() - j.created < 600)]
