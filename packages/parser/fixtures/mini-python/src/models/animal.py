from abc import ABC, abstractmethod
from ..util.formatter import capitalize


class Animal(ABC):
    """Base class for all animals."""

    def __init__(self, name: str, age: int):
        self.name = name
        self.age = age

    @abstractmethod
    def speak(self) -> str:
        pass

    @property
    def display_name(self) -> str:
        return capitalize(self.name)

    def describe(self) -> str:
        return f"{self.display_name} ({self.age} years)"
