"""Metabase REST API client and lookup helpers."""

import time

import requests


class MetabaseClient:
    def __init__(self, base_url):
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()

    def _url(self, path):
        return f"{self.base_url}{path}"

    def get(self, path):
        r = self.session.get(self._url(path))
        r.raise_for_status()
        return r.json()

    def post(self, path, json=None):
        r = self.session.post(self._url(path), json=json)
        r.raise_for_status()
        return r.json()

    def put(self, path, json=None):
        r = self.session.put(self._url(path), json=json)
        r.raise_for_status()
        if r.content:
            return r.json()
        return {}

    def wait_for_ready(self, timeout=300):
        """Wait until Metabase API is responsive."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                r = self.session.get(self._url("/api/health"))
                if r.status_code == 200:
                    print("Metabase is ready.")
                    return
            except requests.ConnectionError:
                pass
            print("Waiting for Metabase...")
            time.sleep(5)
        raise TimeoutError("Metabase did not become ready")

    def authenticate(self, email, password):
        resp = self.post("/api/session", json={"username": email, "password": password})
        self.session.headers["X-Metabase-Session"] = resp["id"]
        print(f"Authenticated as {email}")


def find_database(client, name):
    databases = client.get("/api/database")
    for db in databases.get("data", []):
        if db["name"] == name:
            return db
    return None


def find_card(client, name):
    cards = client.get("/api/card")
    for card in cards:
        if card["name"] == name:
            return card
    return None


def find_dashboard(client, name):
    dashboards = client.get("/api/dashboard")
    for d in dashboards:
        if d["name"] == name:
            return d
    return None
