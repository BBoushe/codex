package com.example.models;

/**
 * Interface for entities that can be printed to output.
 */
public interface Printable {
    void print();
    String format(String template);
}
