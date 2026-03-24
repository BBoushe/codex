package com.example.services;

import java.util.List;
import java.util.ArrayList;
import com.example.models.Animal;
import com.example.models.Dog;
import com.example.models.Printable;

/**
 * Service layer for managing animals.
 * Exercises: cross-file imports, method calls, interface usage.
 */
public class AnimalService {
    private final List<Animal> animals;

    public AnimalService() {
        this.animals = new ArrayList<>();
    }

    public void addAnimal(Animal animal) {
        animals.add(animal);
    }

    public Dog createDog(String name, int age, String breed) {
        Dog dog = new Dog(name, age, breed);
        addAnimal(dog);
        return dog;
    }

    public List<String> getAllSounds() {
        List<String> sounds = new ArrayList<>();
        for (Animal animal : animals) {
            sounds.add(animal.speak());
        }
        return sounds;
    }

    public void printAll() {
        for (Animal animal : animals) {
            if (animal instanceof Printable) {
                ((Printable) animal).print();
            }
        }
    }

    @Deprecated
    public Animal getFirst() {
        if (animals.isEmpty()) {
            return null;
        }
        return animals.get(0);
    }
}
