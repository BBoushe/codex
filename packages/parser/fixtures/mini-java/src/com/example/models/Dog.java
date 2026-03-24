package com.example.models;

import java.util.List;
import java.util.ArrayList;
import com.example.util.Formatter;

/**
 * Dog extends Animal and implements Printable + Serializable.
 * Exercises: inheritance, multiple interfaces, @Override, method calls.
 */
public class Dog extends Animal implements Printable, Serializable {
    private List<String> tricks;
    private String breed;

    public Dog(String name, int age, String breed) {
        super(name, age);
        this.breed = breed;
        this.tricks = new ArrayList<>();
    }

    @Override
    public String speak() {
        return "Woof!";
    }

    @Override
    public void print() {
        System.out.println(format(getDisplayName()));
    }

    @Override
    public String format(String template) {
        return Formatter.format("Dog: %s", template);
    }

    @Override
    public String toJson() {
        return Formatter.toJson(getName(), getAge());
    }

    public void addTrick(String trick) {
        tricks.add(trick);
    }

    public List<String> getTricks() {
        return tricks;
    }

    public String getBreed() {
        return breed;
    }
}
