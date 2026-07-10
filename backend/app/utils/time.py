def seconds_from_gtfs_time(value: str | None, default: int = 0) -> int:
    if not value:
        return default
    hours, minutes, seconds = [int(part) for part in value.split(":")]
    return hours * 3600 + minutes * 60 + seconds


def coarse_cell(lat: float, lon: float, precision: int = 2) -> str:
    return f"grid_{round(lat, precision):.{precision}f}_{round(lon, precision):.{precision}f}"

