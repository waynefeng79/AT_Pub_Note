from collections.abc import Iterator
from contextlib import contextmanager
from typing import TypeAlias, cast

from psycopg import Connection
from psycopg.rows import DictRow, dict_row
from psycopg_pool import ConnectionPool

from app.core.config import Settings

DbConnection: TypeAlias = Connection[DictRow]


class Database:
    def __init__(self, settings: Settings):
        self.pool = cast(
            ConnectionPool[DbConnection],
            ConnectionPool(
                settings.database_url,
                min_size=1,
                max_size=20,
                timeout=5,
                check=ConnectionPool.check_connection,
                kwargs={"row_factory": dict_row},
                open=False,
            ),
        )

    def open(self) -> None:
        self.pool.open()

    def close(self) -> None:
        self.pool.close()

    @contextmanager
    def connection(self) -> Iterator[DbConnection]:
        with self.pool.connection() as conn:
            yield conn
