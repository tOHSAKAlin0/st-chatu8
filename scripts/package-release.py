"""Create an uploadable release without local story evidence or Git history."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import hashlib

root = Path(__file__).resolve().parents[1]
output_dir = root.parent / 'releases'
output_dir.mkdir(exist_ok=True)
archive = output_dir / 'st-chatu8-history-prompts-v1.zip'
files = [root / name for name in (
    'manifest.json', 'index.js', 'style.css', 'settings.html', 'LICENSE',
    'crypto-js.min.js', 'jszip.min.js', 'msgpack.min.js', 'transformers.min.js',
    'presets/novelai-v5-story-agent.json', 'presets/novelai-v5-story-agent-history.json',
    'docs/history-image-prompts.md', 'tests/image-prompt-history.test.cjs',
    'scripts/package-release.py',
)]
for folder in ('html', 'styles', 'tagData'):
    files.extend(p for p in (root / folder).rglob('*') if p.is_file())
public_index = '''# 历史绘图提示词参考版

[功能说明、验证与云酒馆部署](history-image-prompts.md)

[v3 历史提示词预设](../presets/novelai-v5-story-agent-history.json) · [原 v2 预设](../presets/novelai-v5-story-agent.json)

发布包不包含本地剧情实测材料或历史工作交接文件。
'''
readme = (root / 'README.md').read_text(encoding='utf-8')
readme_lines = readme.splitlines()
readme_lines = [line for line in readme_lines if not line.startswith('> 本地补充文档：')]
public_readme = '\n'.join(readme_lines) + '\n'
with ZipFile(archive, 'w', ZIP_DEFLATED) as z:
    for file in sorted(files):
        z.write(file, file.relative_to(root).as_posix())
    z.writestr('README.md', public_readme)
    z.writestr('docs/README.md', public_index)
    z.writestr('.gitignore', 'docs/evidence/\n')
with ZipFile(archive) as z:
    names = z.namelist()
    assert 'manifest.json' in names and 'index.js' in names
    assert not any(name.startswith(('.git/', 'docs/evidence/')) for name in names)
    assert z.testzip() is None
print(archive)
print(f'{len(names)} files; {archive.stat().st_size} bytes')
print('SHA256', hashlib.sha256(archive.read_bytes()).hexdigest())
