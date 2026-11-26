"""Create new, reviewed source/static archives without deleting or publishing files."""
import argparse
import hashlib
import json
import re
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
SKIP = {'.git', '__pycache__', 'node_modules'}
FORBIDDEN = {'.zip', '.sqlite', '.db', '.pyc', '.log', '.pem', '.key', '.bundle', '.csv'}
SOURCE_FILES = (
    '.gitattributes',
    '.gitignore',
    'CODE_LICENSE.md',
    'dist/.nojekyll',
    'dist/app/index.html',
    'dist/case.html',
    'dist/CODE_LICENSE.md',
    'dist/index.html',
    'dist/SOURCE_LICENSE.md',
    'docs/数据口径与交叉核验.md',
    'docs/文件删改清单.md',
    'docs/本地验收记录.md',
    'docs/维护说明.md',
    'evidence/acceptance-checks.json',
    'evidence/data-checks.json',
    'evidence/screenshots/desktop-diagnosis-1440.jpg',
    'evidence/screenshots/desktop-merchants-1440.jpg',
    'evidence/screenshots/desktop-overview-1366.jpg',
    'evidence/screenshots/desktop-overview-1440.jpg',
    'evidence/screenshots/desktop-replay-1440.jpg',
    'evidence/screenshots/mobile-diagnosis-390.jpg',
    'evidence/screenshots/mobile-merchants-390.jpg',
    'evidence/screenshots/mobile-overview-390.jpg',
    'evidence/screenshots/mobile-replay-390.jpg',
    'package.json',
    'README.md',
    'scripts/build.mjs',
    'scripts/package_release.py',
    'scripts/prepare_dashboard.py',
    'scripts/preview.mjs',
    'scripts/verify.mjs',
    'SOURCE_LICENSE.md',
    'src/app.mjs',
    'src/dashboardData.json',
    'src/index.html',
    'src/styles.css',
    'tests/test_dashboard.py',
    'tests/test_runtime.mjs',
)


def collect(directory, allowed=None):
    result = []
    if allowed is None:
        paths = sorted(directory.iterdir())
    else:
        if directory.is_symlink():
            raise ValueError('拒绝符号链接：' + directory.name)
        paths = []
        for name in sorted(allowed):
            relative = Path(name)
            if relative.is_absolute() or '..' in relative.parts:
                raise ValueError('交付白名单路径无效：' + name)
            p = directory
            for part in relative.parts:
                if not p.is_dir():
                    raise ValueError('交付文件的祖先不是目录：' + name)
                p = p / part
                if p.is_symlink():
                    raise ValueError('拒绝符号链接：' + name)
                if not p.exists():
                    raise ValueError('缺少交付文件或目录：' + name)
            if not p.is_file():
                raise ValueError('交付白名单必须是文件：' + name)
            paths.append(p)
    for p in paths:
        if p.name in SKIP:
            continue
        if p.is_symlink():
            raise ValueError('拒绝符号链接：' + p.name)
        if p.is_dir():
            result.extend(collect(p))
        else:
            if p.suffix.lower() in FORBIDDEN or p.name.startswith('.env') or p.name == 'hosting.json':
                raise ValueError('拒绝原始数据、缓存或私人配置：' + p.name)
            body = p.read_bytes()
            if re.search(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{30,}', body):
                raise ValueError('发现凭据形态：' + p.name)
            result.append((p, body))
    return result


def make_archive(destination, files, base):
    records = []
    with ZipFile(destination, 'x', compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for p, body in files:
            name = p.relative_to(base).as_posix()
            archive.writestr(name, body)
            records.append({'path': name, 'bytes': len(body), 'sha256': hashlib.sha256(body).hexdigest()})
    with ZipFile(destination) as archive:
        assert archive.testzip() is None
        assert sorted(archive.namelist()) == sorted(r['path'] for r in records)
        for record in records:
            body = archive.read(record['path'])
            assert len(body) == record['bytes']
            assert hashlib.sha256(body).hexdigest() == record['sha256']
    return {'file': destination.name, 'bytes': destination.stat().st_size,
            'sha256': hashlib.sha256(destination.read_bytes()).hexdigest(), 'files': records}


def main():
    parser = argparse.ArgumentParser(description='瞄店离线源码与静态包')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    if output == ROOT or ROOT in output.parents:
        raise ValueError('输出目录必须位于源码树之外')
    raw = (ROOT / 'src/dashboardData.json').read_bytes()
    assert len(raw) < 80000
    assert len((ROOT / 'dist/index.html').read_bytes()) < 150000
    source = collect(ROOT, SOURCE_FILES)
    if len(source) != 38 or {p.relative_to(ROOT).as_posix() for p, _ in source} != set(SOURCE_FILES):
        raise ValueError('源码交付必须恰好包含38件白名单文件')
    static = collect(ROOT / 'dist')
    assert len(static) == 6
    output.mkdir(parents=True, exist_ok=False)
    receipt = {'status': 'local-packages-verified-not-deployed', 'brand': '瞄店',
               'dataBytes': len(raw), 'runtimeDataRequests': 0,
               'source': make_archive(output / 'miaodian-source.zip', source, ROOT),
               'static': make_archive(output / 'miaodian-static.zip', static, ROOT / 'dist'),
               'privateDataIncluded': False, 'deletedFiles': 0, 'remoteWrites': 0}
    (output / 'release-manifest.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'passed': True, 'output': str(output), 'sourceFiles': len(source),
                      'staticFiles': len(static), 'dataBytes': len(raw),
                      'sourceZipBytes': receipt['source']['bytes'],
                      'staticZipBytes': receipt['static']['bytes'], 'deployed': False}, ensure_ascii=False))


if __name__ == '__main__':
    main()
