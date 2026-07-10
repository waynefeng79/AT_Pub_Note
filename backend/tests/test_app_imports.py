import importlib


def test_production_app_modules_import():
    modules = [
        "app.main",
        "app.api.router",
        "app.repositories.gtfs",
        "app.services.gtfs_importer",
        "app.services.realtime",
        "app.workers.static_import",
        "app.workers.realtime_poll",
    ]
    for module in modules:
        importlib.import_module(module)
