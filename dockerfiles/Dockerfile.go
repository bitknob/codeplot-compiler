FROM golang:latest
WORKDIR /app
CMD ["go", "run", "program.go"]