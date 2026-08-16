# Use official lightweight Node.js Alpine image
FROM node:20-alpine

# Set working directory inside container
WORKDIR /app

# Copy dependency manifests
COPY package.json ./

# Install production dependencies
RUN npm install --only=production

# Copy server code, auth, database access layer, and test suite
COPY server.js db.js auth.js ./
COPY tests ./tests

# Expose port 3000 to client connections
EXPOSE 3000

# Set default start command
CMD ["node", "server.js"]
