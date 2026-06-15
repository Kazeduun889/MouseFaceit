FROM node:18-slim

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY .npmrc ./

# Install with --ignore-scripts to skip native module builds
RUN npm install --ignore-scripts --no-optional

# Copy the rest of the app
COPY . .

# Start the server
EXPOSE 3000
CMD ["node", "backend/server.js"]