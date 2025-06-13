const express = require('express');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');
const dockerode = require('dockerode');
const winston = require('winston');
const { Writable } = require('stream');

const app = express();
let docker;
const MAX_RETRIES = 5;
const RETRY_DELAY = 2000;

async function initializeDocker() {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      docker = new dockerode({ socketPath: '/var/run/docker.sock' });
      await new Promise((resolve, reject) => {
        docker.ping((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
      logger.info('Docker daemon connection established');
      return;
    } catch (err) {
      logger.error(`Docker connection attempt ${attempt} failed: ${err.message}`);
      if (attempt === MAX_RETRIES) {
        logger.error('Failed to initialize dockerode after max retries');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
    }
  }
}

initializeDocker();

const PORT = process.env.PORT || 3000;

// Configure Winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level.toUpperCase()}]: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: path.join(__dirname, 'logs', `${new Date().toISOString().split('T')[0]}.log`),
      maxsize: 10485760, // 10MB
      maxFiles: 7, // Keep 7 days of logs
    }),
  ],
});

// Global error handlers to prevent crashes
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.message}`);
});
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled Rejection: ${reason}`);
});

// Middleware
app.use(bodyParser.json());

// Health check route for Render
app.get('/', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// Supported languages and their configurations
const languageConfigs = {
  c: {
    image: 'gcc:latest',
    ext: 'c',
    compile: 'gcc -o program program.c',
    run: './program',
  },
  cpp: {
    image: 'gcc:latest',
    ext: 'cpp',
    compile: 'g++ -o program program.cpp',
    run: './program',
  },
  java: {
    image: 'openjdk:17',
    ext: 'java',
    fileName: 'Main.java',
    compile: 'javac Main.java',
    run: 'java Main',
  },
  python: {
    image: 'python:3.9',
    ext: 'py',
    run: 'python program.py',
  },
  kotlin: {
    image: 'kotlin:custom',
    ext: 'kt',
    compile: 'kotlinc program.kt -include-runtime -d program.jar',
    run: 'java -jar program.jar',
  },
  scala: {
    image: 'scala:custom',
    ext: 'scala',
    compile: 'scalac program.scala',
    run: 'scala Main',
  },
  javascript: {
    image: 'node:16',
    ext: 'js',
    run: 'node program.js',
  },
  go: {
    image: 'golang:latest',
    ext: 'go',
    run: 'go run program.go',
  },
  ruby: {
    image: 'ruby:latest',
    ext: 'rb',
    run: 'ruby program.rb',
  },
  rust: {
    image: 'rust:latest',
    ext: 'rs',
    compile: 'rustc -o program program.rs',
    run: './program',
  },
  csharp: {
    image: 'mcr.microsoft.com/dotnet/sdk:8.0',
    ext: 'cs',
    run: 'dotnet script /app/program.cs',
  },
};

// Endpoint to execute code
app.post('/api/execute', async (req, res) => {
  logger.info(`Received request: ${JSON.stringify(req.body)}`);

  if (!req.body) {
    logger.error('Request body is missing');
    return res.status(400).json({ error: 'Request body is missing' });
  }

  const { language, code, input } = req.body;

  if (!language || !code) {
    logger.error('Language or code is missing in request');
    return res.status(400).json({ error: 'Language and code are required' });
  }

  if (!languageConfigs[language]) {
    logger.error(`Unsupported language: ${language}`);
    return res.status(400).json({ error: 'Unsupported language' });
  }

  if (!docker) {
    logger.error('Docker daemon is not available');
    return res.status(500).json({ error: 'Docker service unavailable' });
  }

  const config = languageConfigs[language];
  const jobId = uuidv4();
  const workDir = path.join(__dirname, 'temp', jobId);
  const fileName = config.fileName || `program.${config.ext}`;
  const filePath = path.join(workDir, fileName);
  const inputPath = path.join(workDir, 'input.txt');

  let container = null;
  try {
    // Create working directory
    logger.info(`Creating working directory: ${workDir}`);
    await fs.mkdir(workDir, { recursive: true });

    // Write code and input files
    logger.info(`Writing code to: ${filePath}`);
    await fs.writeFile(filePath, code);
    if (input) {
      logger.info(`Writing input to: ${inputPath}`);
      await fs.writeFile(inputPath, input);
    }

    // Prepare Docker command
    let command = [];
    if (config.compile) {
      command.push(config.compile);
      logger.info(`Compilation command: ${config.compile}`);
    }
    command.push(config.run);
    logger.info(`Execution command: ${config.run}`);
    command = command.join(' && ');

    // Create Docker container
    logger.info(`Creating Docker container for image: ${config.image}`);
    try {
      container = await docker.createContainer({
        Image: config.image,
        Cmd: ['/bin/sh', '-c', command],
        WorkingDir: '/app',
        HostConfig: {
          Binds: [`${workDir}:/app`],
          Memory: 1536 * 1024 * 1024, // 1.5GB
          CpuPeriod: 100000,
          CpuQuota: 150000, // 150% CPU
          AutoRemove: false,
        },
        Tty: false,
        OpenStdin: true,
        Detach: true,
      });
    } catch (createErr) {
      logger.error(`Failed to create container: ${createErr.message}`);
      throw createErr;
    }

    // Capture initial container logs
    logger.info(`Capturing initial container logs for: ${container.id}`);
    try {
      const initialLogs = await container.logs({ stdout: true, stderr: true, follow: false });
      logger.info(`Initial container logs: ${initialLogs.toString('utf8')}`);
    } catch (logErr) {
      logger.error(`Failed to capture initial logs: ${logErr.message}`);
    }

    // Start container
    logger.info(`Starting container for job: ${jobId}`);
    try {
      await container.start();
    } catch (startErr) {
      logger.error(`Failed to start container: ${startErr.message}`);
      throw startErr;
    }

    // Attach to container for output
    logger.info('Attaching to container for output');
    let stream;
    try {
      stream = await container.attach({
        stream: true,
        stdout: true,
        stderr: true,
        stdin: true,
      });
    } catch (attachErr) {
      logger.error(`Failed to attach to container: ${attachErr.message}`);
      throw attachErr;
    }

    let output = '';
    let error = '';

    // Create writable streams for stdout and stderr
    const stdoutStream = new Writable({
      write(chunk, encoding, callback) {
        const data = chunk.toString('utf8');
        output += data;
        logger.info(`Captured stdout: ${data}`);
        callback();
      },
    });

    const stderrStream = new Writable({
      write(chunk, encoding, callback) {
        const data = chunk.toString('utf8');
        error += data;
        logger.info(`Captured stderr: ${data}`);
        callback();
      },
    });

    // Debug stream attachment
    stream.on('error', (err) => {
      logger.error(`Stream error: ${err.message}`);
    });
    stream.on('end', () => {
      logger.info('Stream ended');
    });

    // Use demuxStream to separate stdout and stderr
    try {
      docker.modem.demuxStream(stream, stdoutStream, stderrStream);
    } catch (demuxErr) {
      logger.error(`Failed to demux stream: ${demuxErr.message}`);
      throw demuxErr;
    }

    // Feed input if provided
    if (input) {
      logger.info(`Feeding input to container: ${input}`);
      try {
        stream.write(input);
      } catch (inputErr) {
        logger.error(`Failed to write input: ${inputErr.message}`);
        throw inputErr;
      }
    }

    // Wait for container to finish
    logger.info(`Waiting for container to finish (timeout ${['csharp', 'javascript'].includes(language) ? 60 : 15}s)`);
    const timeout = ['csharp', 'javascript'].includes(language) ? 60000 : 15000;
    let waitResult;
    try {
      waitResult = await container.wait({ condition: 'not-running', timeout });
    } catch (waitErr) {
      logger.error(`Failed to wait for container: ${waitErr.message}`);
      // Capture container logs
      try {
        const inspect = await container.inspect();
        logger.info(`Container inspect: ${JSON.stringify(inspect.State)}`);
        const logs = await container.logs({ stdout: true, stderr: true, follow: false });
        logger.info(`Container logs: ${logs.toString('utf8')}`);
      } catch (inspectErr) {
        logger.error(`Failed to inspect container: ${inspectErr.message}`);
      }
      throw waitErr;
    }
    const { StatusCode } = waitResult;

    // Log raw output and error
    logger.info(`Raw output: ${output}`);
    logger.info(`Raw error: ${error}`);
    logger.info(`Container exit code: ${StatusCode}`);

    // Clean up container
    logger.info(`Removing container: ${container.id}`);
    try {
      await container.remove({ force: true });
    } catch (removeErr) {
      logger.error(`Failed to remove container: ${removeErr.message}`);
    }

    // Clean up working directory
    logger.info(`Cleaning up working directory: ${workDir}`);
    await fs.rm(workDir, { recursive: true, force: true });

    if (StatusCode !== 0) {
      logger.error(`Execution failed with status code: ${StatusCode}`);
      return res.status(500).json({ error: error || 'Execution failed' });
    }

    logger.info(`Sending response: ${JSON.stringify({ output, error })}`);
    res.json({ output, error });
  } catch (err) {
    logger.error(`Error during execution: ${err.message}`);
    // Clean up container if created
    if (container) {
      try {
        await container.remove({ force: true });
      } catch (removeErr) {
        logger.error(`Failed to remove container: ${removeErr.message}`);
      }
    }
    // Clean up working directory
    await fs.rm(workDir, { recursive: true, force: true });
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});