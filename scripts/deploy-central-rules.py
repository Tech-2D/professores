"""Publish the checked-in rules of the central Firebase project."""
from pathlib import Path

from google.auth.transport.requests import AuthorizedSession
from google.oauth2 import service_account

ROOT = Path(__file__).resolve().parents[1]
PROJECT = "d-tech-8555e"
credentials = service_account.Credentials.from_service_account_file(
    str(ROOT / "firebase-credentials/2d-tech-novo.json"),
    scopes=["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/firebase"],
)
if credentials.project_id != PROJECT:
    raise SystemExit("Credential project does not match destination")
session = AuthorizedSession(credentials)
base = f"https://firebaserules.googleapis.com/v1/projects/{PROJECT}"
content = (ROOT / "firestore.rules").read_text(encoding="utf-8")
created = session.post(base + "/rulesets", json={"source": {"files": [{"name": "firestore.rules", "content": content}]}}, timeout=60)
created.raise_for_status()
ruleset_name = created.json()["name"]
release = session.patch(base + "/releases/cloud.firestore", params={"updateMask": "rulesetName"}, json={
    "release": {"name": f"projects/{PROJECT}/releases/cloud.firestore", "rulesetName": ruleset_name}
}, timeout=60)
release.raise_for_status()
print(f"Published Firestore rules for {PROJECT}: {ruleset_name}")
