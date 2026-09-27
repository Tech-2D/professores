"""Copy the central Firebase without deleting source data. Snapshots stay ignored by Git."""
import argparse
import hashlib
import importlib.util
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import firebase_admin
from firebase_admin import auth, credentials, firestore
from google.api_core.exceptions import AlreadyExists

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('migration_codec', ROOT / 'scripts/migrate-firestore.py')
codec = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = codec
spec.loader.exec_module(codec)


def connect(filename, project, name):
    credential = credentials.Certificate(str(ROOT / 'firebase-credentials' / filename))
    if credential.project_id != project:
        raise ValueError('Unexpected credential project')
    return firebase_admin.initialize_app(credential, name=name)


def export_database(db):
    result = {}
    pending = list(db.collections(timeout=60))
    with ThreadPoolExecutor(max_workers=8) as pool:
        while pending:
            col = pending.pop(0)
            snapshots = list(col.stream(timeout=60))
            for item in snapshots:
                result[item.reference.path] = codec.encode_value(item.to_dict())
            # list_documents includes missing parent documents that own subcollections.
            refs = list(col.list_documents(timeout=60))
            for children in pool.map(lambda ref: list(ref.collections(timeout=60)), refs):
                pending.extend(children)
            print('Exported collection:', (col.parent.path + '/' if col.parent else '') + col.id, len(snapshots), flush=True)
    return result


def export_users(app):
    return [{
        'uid': u.uid, 'email': u.email, 'email_verified': u.email_verified,
        'display_name': u.display_name, 'phone_number': u.phone_number,
        'photo_url': u.photo_url, 'disabled': u.disabled, 'custom_claims': u.custom_claims,
        'creation_timestamp': u.user_metadata.creation_timestamp,
        'last_sign_in_timestamp': u.user_metadata.last_sign_in_timestamp,
        'providers': [{'uid': p.uid, 'provider_id': p.provider_id, 'email': p.email,
                       'display_name': p.display_name, 'photo_url': p.photo_url}
                      for p in u.provider_data if p.provider_id != 'password'],
    } for u in auth.list_users(app=app).iterate_all()]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--verify', action='store_true')
    parser.add_argument('--verify-source', action='store_true')
    args = parser.parse_args()
    source = connect('d-tech.json', 'd-tech-56a76', 'migration-source')
    destination = connect('2d-tech-novo.json', 'd-tech-8555e', 'migration-destination')
    src, dst = firestore.client(source), firestore.client(destination)
    directory = ROOT / 'firestore-snapshots' / 'central-8555e'
    directory.mkdir(parents=True, exist_ok=True)
    snapshot_file = directory / 'source.json'
    if not snapshot_file.exists():
        payload = {'documents': export_database(src), 'users': export_users(source)}
        snapshot_file.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
    payload = json.loads(snapshot_file.read_text(encoding='utf-8'))
    print('Snapshot:', len(payload['documents']), 'documents;', len(payload['users']), 'users', flush=True)
    if args.verify_source:
        if export_database(src) != payload['documents']:
            raise RuntimeError('Source changed after snapshot; reconcile before cutover')
        current = export_users(source)
        def stable(users):
            return sorted([{k: v for k, v in u.items() if k != 'last_sign_in_timestamp'} for u in users], key=lambda u: u['uid'])
        if stable(current) != stable(payload['users']):
            raise RuntimeError('Source user profiles changed after snapshot')
        print('VERIFIED: source still matches snapshot.', flush=True)
        return
    if args.verify:
        copied = export_database(dst)
        if copied != payload['documents']:
            raise RuntimeError('Destination Firestore does not match snapshot')
        users = export_users(destination)
        if sorted(users, key=lambda u: u['uid']) != sorted(payload['users'], key=lambda u: u['uid']):
            raise RuntimeError('Destination user profiles do not match snapshot')
        print('VERIFIED: documents, subcollections, UIDs and user profiles match.', flush=True)
        return
    if not args.execute:
        return
    password = os.environ.get('MIGRATION_INITIAL_PASSWORD')
    if not password:
        raise RuntimeError('MIGRATION_INITIAL_PASSWORD is required')
    existing = export_users(destination)
    source_by_uid = {u['uid']: u for u in payload['users']}
    for user in existing:
        if user != source_by_uid.get(user['uid']):
            raise RuntimeError('Conflicting destination account; refusing to overwrite')
    existing_ids = {u['uid'] for u in existing}
    records = []
    for user in payload['users']:
        if user['uid'] in existing_ids:
            continue
        salt = os.urandom(16)
        fields = {key: user[key] for key in ['uid', 'email', 'email_verified', 'display_name', 'phone_number', 'photo_url', 'disabled', 'custom_claims']}
        records.append(auth.ImportUserRecord(
            **fields,
            user_metadata=auth.UserMetadata(creation_timestamp=user['creation_timestamp'], last_sign_in_timestamp=user['last_sign_in_timestamp']),
            provider_data=[auth.UserProvider(**p) for p in user['providers']],
            password_hash=hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 100000), password_salt=salt,
        ))
    if records:
        outcome = auth.import_users(records, hash_alg=auth.UserImportHash.pbkdf2_sha256(100000), app=destination)
        if outcome.failure_count:
            raise RuntimeError('Auth import failed: ' + str([(e.index, e.reason) for e in outcome.errors]))
        print('Imported accounts:', outcome.success_count, flush=True)
    for index, (path, encoded) in enumerate(payload['documents'].items(), 1):
        data = codec.decode_value(encoded, dst)
        ref = dst.document(path)
        try:
            ref.create(data, timeout=60)
        except AlreadyExists:
            if codec.encode_value(ref.get(timeout=60).to_dict()) != encoded:
                raise RuntimeError('Conflicting destination document: ' + path)
        if index % 100 == 0:
            print('Copied documents:', index, flush=True)
    print('Copy completed. Run --verify.', flush=True)


if __name__ == '__main__':
    main()
