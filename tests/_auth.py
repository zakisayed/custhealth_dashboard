"""Sign a TestClient in as the admin (fresh databases start with admin@dvsum.com / ChangeMe)."""
TEST_PASSWORD = "TestPass123!"


def sign_in(client, email="admin@dvsum.com"):
    r = client.post("/api/auth/login", json={"email": email, "password": "ChangeMe"})
    if r.status_code == 200 and r.json()["user"]["must_change_password"]:
        tok = r.json()["token"]
        r = client.post("/api/auth/change-password", headers={"Authorization": f"Bearer {tok}"},
                        json={"current_password": "ChangeMe", "new_password": TEST_PASSWORD})
    if r.status_code != 200:
        r = client.post("/api/auth/login", json={"email": email, "password": TEST_PASSWORD})
    assert r.status_code == 200, r.text
    client.headers["Authorization"] = f"Bearer {r.json()['token']}"
    return r.json()
