FROM openjdk:17
WORKDIR /app
CMD ["/bin/sh", "-c", "javac Main.java && java Main"]