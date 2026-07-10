from app.db.session import DbConnection


class UserRepository:
    def __init__(self, conn: DbConnection):
        self.conn = conn

    def create_user(self, email: str, password_hash: str) -> dict | None:
        row = self.conn.execute(
            """
            INSERT INTO users(email, password_hash)
            VALUES (%s, %s)
            ON CONFLICT (email) DO NOTHING
            RETURNING id, email
            """,
            (email.lower(), password_hash),
        ).fetchone()
        return dict(row) if row else None

    def get_by_email(self, email: str) -> dict | None:
        row = self.conn.execute("SELECT id, email, password_hash FROM users WHERE email = %s", (email.lower(),)).fetchone()
        return dict(row) if row else None

    def get_by_id(self, user_id: int) -> dict | None:
        row = self.conn.execute("SELECT id, email FROM users WHERE id = %s", (user_id,)).fetchone()
        return dict(row) if row else None

    def favourite_routes(self, user_id: int) -> list[str]:
        rows = self.conn.execute(
            "SELECT route_id FROM user_favourite_routes WHERE user_id = %s ORDER BY route_id",
            (user_id,),
        ).fetchall()
        return [row["route_id"] for row in rows]

    def replace_favourites(self, user_id: int, route_ids: list[str]) -> list[str]:
        self.conn.execute("DELETE FROM user_favourite_routes WHERE user_id = %s", (user_id,))
        if route_ids:
            with self.conn.cursor() as cursor:
                cursor.executemany(
                    "INSERT INTO user_favourite_routes(user_id, route_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                    [(user_id, route_id) for route_id in route_ids],
                )
        return self.favourite_routes(user_id)

    def add_favourite(self, user_id: int, route_id: str) -> list[str]:
        self.conn.execute(
            "INSERT INTO user_favourite_routes(user_id, route_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
            (user_id, route_id),
        )
        return self.favourite_routes(user_id)

    def remove_favourite(self, user_id: int, route_id: str) -> list[str]:
        self.conn.execute("DELETE FROM user_favourite_routes WHERE user_id = %s AND route_id = %s", (user_id, route_id))
        return self.favourite_routes(user_id)
