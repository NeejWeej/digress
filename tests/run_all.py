"""Run every browser test. test_server.py asserts; the older UI scripts print what they observe
and are counted as failed if they crash or the page throws an error (their screenshots land in tests/.artifacts).

Each test file is its own process (its own browser, its own server on a free port, its own temp data), so
they run side by side: -j N at once (default: half the cores, at most 8; -j 1 runs them one by one). The
slowest run first, by the times recorded last run, so the long ones don't end up last.

    python3 tests/run_all.py [-j N] [name ...]"""
import json, os, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor, as_completed

here = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[1:]
jobs = max(1, min(8, (os.cpu_count() or 2) // 2))
if args[:1] == ['-j']: jobs = int(args[1]); args = args[2:]
only = args
arts = os.path.join(here, '.artifacts'); os.makedirs(arts, exist_ok=True)
times_file = os.path.join(arts, 'durations.json')
try: last = json.load(open(times_file))
except Exception: last = {}

names = sorted(n for n in os.listdir(here) if n.startswith('test_') and n.endswith('.py') and (not only or any(o in n for o in only)))
names.sort(key=lambda n: -last.get(n, 60))   # unknown ones count as slow-ish

def run(name):
    t = time.time()
    try:
        r = subprocess.run([sys.executable, os.path.join(here, name)], cwd=here, capture_output=True, text=True, timeout=600)
        out, code = r.stdout + r.stderr, r.returncode
    except subprocess.TimeoutExpired as e:
        out, code = (e.stdout or '') + (e.stderr or '') + '\n[timed out after 600s]', 1
    if isinstance(out, bytes): out = out.decode(errors='replace')
    open(os.path.join(arts, name + '.log'), 'w').write(out)
    return name, code != 0 or 'PAGEERR' in out, time.time() - t, out

t0 = time.time(); results = {}
with ThreadPoolExecutor(jobs) as ex:
    for f in as_completed([ex.submit(run, n) for n in names]):
        name, bad, dt, out = f.result(); results[name] = (bad, dt)
        print(('FAIL' if bad else 'ok  '), f'{name:28} {dt:5.1f}s', flush=True)
        if bad: print('\n'.join('     ' + l for l in out.strip().splitlines()[-15:]), flush=True)
last.update({n: round(dt, 1) for n, (bad, dt) in results.items()})
json.dump(last, open(times_file, 'w'), indent=0, sort_keys=True)
failed = sorted(n for n, (bad, _) in results.items() if bad)
print(f'\n{len(names)} tests, {jobs} at a time, {time.time() - t0:.0f}s')
print(f'{len(failed)} failed: {" ".join(failed)}' if failed else 'all passed')
sys.exit(1 if failed else 0)
