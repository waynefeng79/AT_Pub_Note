import argparse
import logging
import time

from app.core.config import get_settings
from app.db.session import Database
from app.services.gtfs_importer import GtfsImporter, StaticImportAlreadyRunning

logger = logging.getLogger(__name__)


def run_once() -> str:
    settings = get_settings()
    db = Database(settings)
    db.open()
    try:
        with db.connection() as conn:
            feed_version = GtfsImporter(settings).import_feed(conn)
            conn.commit()
            logger.info("Imported active GTFS feed %s", feed_version)
            return feed_version
    finally:
        db.close()


def run_loop() -> None:
    settings = get_settings()
    while True:
        try:
            run_once()
        except StaticImportAlreadyRunning as exc:
            logger.error("%s", exc)
            raise
        except Exception:
            logger.exception("Static GTFS import failed")
        time.sleep(settings.gtfs_static_poll_seconds)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser()
    parser.add_argument("--loop", action="store_true")
    args = parser.parse_args()
    if args.loop:
        run_loop()
    else:
        run_once()
