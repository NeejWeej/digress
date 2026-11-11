"""Run every browser test. test_server.py asserts; the older UI scripts print what they observe
and are counted as failed if they crash or the page throws an error (their screenshots land in tests/.artifacts)."""
import glob, os, subprocess, sys, time

here = os.path.dirname(os.path.abspath(__file__))
only = sys.argv[1:]
failed = []
for path in sorted(glob.glob(os.path.join(here, 'test_*.py'))):
    name = os.path.basename(path)
    if only and not any(o in name for o in only):
        continue
    t = time.time()
    r = subprocess.run([sys.executable, path], cwd=here, capture_output=True, text=True, timeout=600)
    out = r.stdout + r.stderr
    bad = r.returncode != 0 or 'PAGEERR' in out
    os.makedirs(os.path.join(here, '.artifacts'), exist_ok=True)
    open(os.path.join(here, '.artifacts', name + '.log'), 'w').write(out)
    print(('FAIL' if bad else 'ok  '), f'{name:28} {time.time() - t:5.1f}s')
    if bad:
        failed.append(name)
        print('\n'.join('     ' + l for l in out.strip().splitlines()[-15:]))
print(f'\n{len(failed)} failed' if failed else '\nall passed')
sys.exit(1 if failed else 0)
