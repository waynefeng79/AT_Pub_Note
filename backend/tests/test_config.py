import pytest
from pydantic import ValidationError

from app.core.config import Settings


def test_journey_chain_settings_have_safe_defaults():
    settings = Settings(_env_file=None)
    assert settings.journey_max_transfers == 2
    assert settings.journey_transfer_buffer_seconds >= 0
    assert settings.journey_access_radius_m >= 100


def test_more_than_two_transfers_is_rejected():
    with pytest.raises(ValidationError):
        Settings(_env_file=None, journey_max_transfers=3)


def test_public_nominatim_requires_operator_contact_in_production():
    with pytest.raises(ValidationError):
        Settings(_env_file=None, environment="production", nominatim_public_policy=True, nominatim_contact="")
