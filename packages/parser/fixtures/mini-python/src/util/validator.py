"""Input validation utilities."""


def validate_age(age: int) -> bool:
    return 0 < age < 150


def validate_name(name: str) -> bool:
    return bool(name) and len(name) <= 100
