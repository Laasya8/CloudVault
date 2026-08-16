# Use the official lightweight Node.js Alpine image
FROM node:20-alpine

# Set working directory inside the container
WORKDIR /app

# Copy dependency manifests
COPY package.json ./

# Install production dependencies
RUN npm install --only=production

# Copy the server source code
COPY server.js ./

# Set environment variables
ENV PORT=5001
ENV STORAGE_DIR=/app/data
ENV CHUNK_SIZE=1048576

# Create directory to store uploaded files
RUN mkdir -p /app/data

# Expose port 5001 to the outside world
EXPOSE 5001

# Command to run the service
CMD ["node", "server.js"]
