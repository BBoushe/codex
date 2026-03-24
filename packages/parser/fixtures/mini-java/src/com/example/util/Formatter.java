package com.example.util;

/**
 * Utility class with static formatting methods.
 * Exercises: static methods, cross-file call targets.
 */
public class Formatter {

    public static String capitalize(String input) {
        if (input == null || input.isEmpty()) {
            return input;
        }
        return input.substring(0, 1).toUpperCase() + input.substring(1);
    }

    public static String format(String pattern, String... args) {
        return String.format(pattern, (Object[]) args);
    }

    public static String toJson(String name, int age) {
        return String.format("{\"name\":\"%s\",\"age\":%d}", name, age);
    }
}
