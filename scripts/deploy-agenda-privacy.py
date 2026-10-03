"""Safely compare and optionally publish Agenda privacy rules, without touching data."""
import argparse
import subprocess
from pathlib import Path
from google.auth.transport.requests import AuthorizedSession
from google.oauth2 import service_account

parser = argparse.ArgumentParser()
parser.add_argument('--execute', action='store_true')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
agenda = root.parent / 'Agenda'
project = 'd-tech-8555e'
credentials = service_account.Credentials.from_service_account_file(
    str(root / 'firebase-credentials/2d-tech-novo.json'),
    scopes=['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/firebase'])
if credentials.project_id != project:
    raise SystemExit('Wrong credential project')
session = AuthorizedSession(credentials)
base = f'https://firebaserules.googleapis.com/v1/projects/{project}'
try:
    release = session.get(base + '/releases/cloud.firestore', timeout=30)
    release.raise_for_status()
    name = release.json()['rulesetName']
    current = session.get('https://firebaserules.googleapis.com/v1/' + name, timeout=30)
    current.raise_for_status()
    deployed = current.json()['source']['files'][0]['content'].replace('\r\n', '\n').strip()
    baseline = subprocess.check_output(['git', 'show', 'HEAD:firestore.rules'], cwd=agenda).decode('utf-8').replace('\r\n', '\n').strip()
    target = (agenda / 'firestore.rules').read_text(encoding='utf-8').replace('\r\n', '\n').strip()
    if deployed != baseline and deployed != target:
        raise SystemExit('Deployed rules differ from Agenda baseline; refusing to overwrite concurrent changes')
    print('Baseline confirmed; privacy rules ready')
    if args.execute and deployed != target:
        created = session.post(base + '/rulesets', json={'source': {'files': [{'name': 'firestore.rules', 'content': target}]}}, timeout=30)
        created.raise_for_status()
        # Recheck the release immediately before changing it.
        check = session.get(base + '/releases/cloud.firestore', timeout=30)
        check.raise_for_status()
        if check.json()['rulesetName'] != name:
            raise SystemExit('Concurrent publication detected; refusing to overwrite')
        updated = session.patch(base + '/releases/cloud.firestore', params={'updateMask': 'rulesetName'}, json={'release': {'name': f'projects/{project}/releases/cloud.firestore', 'rulesetName': created.json()['name']}}, timeout=30)
        updated.raise_for_status()
        print('Privacy rules published')
except Exception as error:
    print('Rules deployment unavailable:', type(error).__name__)
    raise SystemExit(1)
