FROM gcc:latest
WORKDIR /app
CMD ["/bin/sh", "-c", "gcc -o program program.c && ./program || g++ -o program program.cpp && ./program"]