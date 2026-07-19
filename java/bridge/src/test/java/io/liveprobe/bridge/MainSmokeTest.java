package io.liveprobe.bridge;

/** Dependency-free smoke test runnable with plain java. */
public final class MainSmokeTest {
    private MainSmokeTest() {}

    public static void main(String[] args) throws ClassNotFoundException {
        Class.forName("io.liveprobe.bridge.Main");
    }
}
