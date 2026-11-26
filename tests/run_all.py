"""Run every browser test. test_server.py asserts; the older UI scripts print what they observe
and are counted as failed if they crash or the page throws an error (their screenshots land in tests/.artifacts).

By default, tests run in a pool of persistent worker processes (`tests/worker.py`), each keeping one
browser process alive and giving every test fresh isolated BrowserContexts (cookies, localStorage,
IndexedDB, service workers, cache). Pass `--isolated` to spawn a separate Python + browser process per
test file. The slowest run first, by the times recorded last run, so the long ones don't end up last.

    python3 tests/run_all.py [-j N] [--isolated] [name ...]"""
import json, os, queue, subprocess, sys, threading, time
from concurrent.futures import ThreadPoolExecutor, as_completed

here = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
cpus = os.cpu_count() or 2
jobs = max(1, min(10, cpus - 2 if cpus > 4 else cpus // 2))
isolated = False
while args:
    if args[0] == '-j':
        jobs = int(args[1]); args = args[2:]
    elif args[0] == '--isolated':
        isolated = True; args = args[1:]
    else:
        break
only = args
arts = os.path.join(here, '.artifacts'); os.makedirs(arts, exist_ok=True)
times_file = os.path.join(arts, 'durations.json')
try: last = json.load(open(times_file))
except Exception: last = {}

names = sorted(n for n in os.listdir(here) if n.startswith('test_') and n.endswith('.py') and (not only or any(o in n for o in only)))
names.sort(key=lambda n: -last.get(n, 60))   # unknown ones count as slow-ish

def run_isolated(name):
    t = time.time()
    try:
        r = subprocess.run([sys.executable, os.path.join(here, name)], cwd=here, capture_output=True, text=True, timeout=600)
        out, code = r.stdout + r.stderr, r.returncode
    except subprocess.TimeoutExpired as e:
        out, code = (e.stdout or '') + (e.stderr or '') + '\n[timed out after 600s]', 1
    if isinstance(out, bytes): out = out.decode(errors='replace')
    open(os.path.join(arts, name + '.log'), 'w').write(out)
    return name, code != 0 or 'PAGEERR' in out, time.time() - t, out

def run_pooled(names, n_workers):
    q = queue.Queue()
    for n in names:
        q.put(n)
    results = {}
    lock = threading.Lock()
    worker_py = os.path.join(here, 'worker.py')

    def start_worker():
        return subprocess.Popen(
            [sys.executable, worker_py],
            cwd=here, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
        )

    def read_line_timeout(proc, timeout=600):
        box = [None]
        def reader():
            try: box[0] = proc.stdout.readline()
            except Exception: box[0] = ''
        th = threading.Thread(target=reader, daemon=True)
        th.start(); th.join(timeout)
        if th.is_alive():
            try: proc.kill()
            except Exception: pass
            return None
        return box[0]

    def worker_loop():
        proc = None
        try:
            while True:
                try: name = q.get_nowait()
                except queue.Empty: break
                if proc is None or proc.poll() is not None:
                    proc = start_worker()
                t0 = time.time()
                try:
                    proc.stdin.write(name + '\n')
                    proc.stdin.flush()
                    line = read_line_timeout(proc, 600)
                except Exception as e:
                    line = f'[worker write error: {e}]'
                    try: proc.kill()
                    except Exception: pass
                    proc = None
                if line is None:
                    out, code, dt = '[timed out after 600s]\n', 1, time.time() - t0
                    proc = None
                else:
                    try:
                        msg = json.loads(line)
                        out, code, dt = msg['out'], msg['code'], msg['dt']
                    except Exception:
                        rest = ''
                        try: rest = proc.stdout.read()
                        except Exception: pass
                        out, code, dt = (line + rest) or '[worker exited unexpectedly]\n', 1, time.time() - t0
                        try: proc.kill()
                        except Exception: pass
                        proc = None
                open(os.path.join(arts, name + '.log'), 'w').write(out)
                bad = code != 0 or 'PAGEERR' in out
                with lock:
                    results[name] = (bad, dt)
                    print(('FAIL' if bad else 'ok  '), f'{name:28} {dt:5.1f}s', flush=True)
                    if bad:
                        print('\n'.join('     ' + l for l in out.strip().splitlines()[-15:]), flush=True)
                q.task_done()
        finally:
            if proc is not None and proc.poll() is None:
                try: proc.stdin.close()
                except Exception: pass
                try: proc.wait(timeout=10)
                except Exception: proc.kill()

    n_workers = max(1, min(n_workers, len(names)))
    threads = [threading.Thread(target=worker_loop) for _ in range(n_workers)]
    for th in threads: th.start()
    for th in threads: th.join()
    return results

t0 = time.time()
if isolated or len(names) <= 1:
    results = {}
    with ThreadPoolExecutor(jobs) as ex:
        for f in as_completed([ex.submit(run_isolated, n) for n in names]):
            name, bad, dt, out = f.result(); results[name] = (bad, dt)
            print(('FAIL' if bad else 'ok  '), f'{name:28} {dt:5.1f}s', flush=True)
            if bad: print('\n'.join('     ' + l for l in out.strip().splitlines()[-15:]), flush=True)
else:
    results = run_pooled(names, jobs)

last.update({n: round(dt, 1) for n, (bad, dt) in results.items()})
json.dump(last, open(times_file, 'w'), indent=0, sort_keys=True)
failed = sorted(n for n, (bad, _) in results.items() if bad)
print(f'\n{len(names)} tests, {jobs} at a time, {time.time() - t0:.0f}s')
print(f'{len(failed)} failed: {" ".join(failed)}' if failed else 'all passed')
sys.exit(1 if failed else 0)
