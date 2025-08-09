import { getStroke } from 'https://cdn.skypack.dev/perfect-freehand';

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

let ws;
let isConnected = false;
let selectedIcon = '';
let myPlayerId = null;
let players = [];
let gameState = 'waiting'; // 'waiting', 'originalDrawing', 'viewing', 'recreating', 'gallery'
let currentDrawer = null;
let timeLeft = 0;
let timerInterval = null;

// Drawing state
let allSquibbles = [];
let points = [];
let drawing = false;
let size = 16;
let thinning = 0.6;
let smoothing = 0.8;
let streamline = 0.5;
let drawColor = '#000000';

// Save the original drawing and recreations
let originalDrawing = [];
let myRecreation = [];
let allRecreations = [];
let votedWinner = null;

function connectWebSocket() {
    // Use dynamic URL for production
    const wsUrl = window.location.protocol === 'https:' 
        ? `wss://${window.location.host}` 
        : `ws://${window.location.host}`;
    
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
        console.log('Connected');
        isConnected = true;
    };
    
    ws.onmessage = async (event) => {
        try {
            let messageData = event.data;
            if (messageData instanceof Blob) {
                messageData = await messageData.text();
            }
            
            const data = JSON.parse(messageData);
            handleMessage(data);
        } catch (error) {
            console.error('Error:', error);
        }
    };
    
    ws.onclose = () => {
        console.log('Disconnected');
        isConnected = false;
        setTimeout(connectWebSocket, 3000);
    };
}

function handleMessage(message) {
    console.log('Received:', message.type, message.data);
    
    switch (message.type) {
        case 'playerJoined':
            const existingPlayer = players.find(p => p.id === message.data.id);
            if (!existingPlayer) {
                players.push(message.data);
                // Sort players by ID to ensure consistent order across all clients
                players.sort((a, b) => a.id.localeCompare(b.id));
                updateWaitingDisplay();
                console.log('Player joined:', message.data);
            }
            
            // If someone new joined and I'm already in the game, send them my info
            if (myPlayerId && message.data.id !== myPlayerId) {
                sendMessage('playerInfo', { id: myPlayerId, icon: selectedIcon });
            }
            break;
            
        case 'playerInfo':
            const existingInfo = players.find(p => p.id === message.data.id);
            if (!existingInfo) {
                players.push(message.data);
                // Sort players by ID to ensure consistent order across all clients
                players.sort((a, b) => a.id.localeCompare(b.id));
                updateWaitingDisplay();
                console.log('Received player info:', message.data);
            }
            break;
            
        case 'playerLeft':
            players = players.filter(p => p.id !== message.data.id);
            updateWaitingDisplay();
            updatePlayersDisplay();
            console.log('Player left:', message.data.id);
            break;
            
        case 'startGame':
            // Use the first player in the sorted list as the drawer
            if (players.length >= 3) { // Changed from 2 to 3
                const firstDrawer = players[0]; // Always pick the first player
                gameState = 'originalDrawing';
                currentDrawer = firstDrawer.id;
                startOriginalDrawing();
                
                // Send gameStarted to everyone else with the chosen drawer
                sendMessage('gameStarted', { drawer: firstDrawer.id });
            }
            break;
            
        case 'gameStarted':
            // Everyone else just uses the drawer that was chosen
            gameState = 'originalDrawing';
            currentDrawer = message.data.drawer;
            startOriginalDrawing();
            break;
            
        case 'originalComplete':
            originalDrawing = message.data.drawing;
            startViewingPhase();
            break;
            
        case 'startRecreating':
            startRecreatingPhase();
            break;
            
        case 'recreationSubmitted':
            // Collect recreations from other players
            const recreation = {
                playerId: message.data.playerId,
                drawing: message.data.drawing,
                playerIcon: players.find(p => p.id === message.data.playerId)?.icon || '🎨'
            };
            
            // Check if this recreation already exists
            const existingRecreation = allRecreations.findIndex(r => r.playerId === recreation.playerId);
            if (existingRecreation === -1) {
                allRecreations.push(recreation);
                console.log(`Received recreation from ${recreation.playerId}. Total recreations: ${allRecreations.length}`);
            }
            
            // Check if we have all recreations (all players except the drawer)
            const expectedRecreations = players.length - 1; // Everyone except the drawer
            if (allRecreations.length >= expectedRecreations) {
                console.log('All recreations received, starting gallery');
                sendMessage('showGallery', { recreations: allRecreations });
                showGallery();
            }
            break;
            
        case 'showGallery':
            // Make sure we have the latest recreations
            allRecreations = message.data.recreations;
            showGallery();
            break;
            
        case 'voteSubmitted':
            // Show everyone who the drawer voted for
            votedWinner = message.data.winnerId;
            showVoteResult();
            break;
            
        case 'nextRound':
            // Move to next drawer in the order
            currentDrawer = message.data.drawer;
            gameState = 'originalDrawing';
            startOriginalDrawing();
            break;
            
        case 'stroke':
            if (gameState === 'originalDrawing') {
                allSquibbles.push(message.data);
                redraw();
            }
            break;
            
        case 'clear':
            allSquibbles = [];
            redraw();
            break;
    }
}

function sendMessage(type, data) {
    if (ws && isConnected && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type, data }));
    }
}

function startTimer(seconds, onComplete) {
    timeLeft = seconds;
    const totalTime = seconds;
    updateTimerBar(timeLeft, totalTime);
    
    if (timerInterval) clearInterval(timerInterval);
    
    timerInterval = setInterval(() => {
        timeLeft--;
        updateTimerBar(timeLeft, totalTime);
        
        if (timeLeft <= 0) {
            clearInterval(timerInterval);
            onComplete();
        }
    }, 1000);
}

function updateTimerBar(timeLeft, totalTime) {
    const timerBar = document.getElementById('timer-bar');
    if (!timerBar) return;
    
    const totalBars = 10;
    const filledBars = Math.ceil((timeLeft / totalTime) * totalBars);
    
    let barString = '';
    for (let i = 0; i < totalBars; i++) {
        if (i < filledBars) {
            barString += '🟩'; // Green filled bar
        } else {
            barString += '⬜'; // Empty bar
        }
    }
    
    timerBar.textContent = barString;
    
    // Hide timer bar when no time left
    if (timeLeft <= 0) {
        timerBar.style.display = 'none';
    } else {
        timerBar.style.display = 'block';
    }
}

function startOriginalDrawing() {
    // Switch to game screen
    document.getElementById('waiting-screen').style.display = 'none';
    document.getElementById('game-screen').style.display = 'flex';
    
    // Clear everything for new round
    allSquibbles = [];
    originalDrawing = [];
    myRecreation = [];
    allRecreations = [];
    votedWinner = null;
    
    // Hide gallery if it exists
    const gallery = document.getElementById('gallery');
    if (gallery) gallery.style.display = 'none';
    
    // Show canvas
    canvas.style.display = 'block';
    
    // Show timer bar
    const timerBar = document.getElementById('timer-bar');
    if (timerBar) timerBar.style.display = 'block';
    
    // Update UI based on role
    const gameStatus = document.getElementById('game-status');
    
    if (currentDrawer === myPlayerId) {
        gameStatus.textContent = '✏️';
        canvas.classList.remove('watching');
        
        // Start 10 second timer for drawing
        startTimer(10, () => {
            // Save the drawing and send to others
            originalDrawing = [...allSquibbles];
            sendMessage('originalComplete', { drawing: originalDrawing });
            startViewingPhase();
        });
    } else {
        gameStatus.textContent = '👀';
        canvas.classList.add('watching');
    }
    
    // Setup canvas and display
    resize();
    updatePlayersDisplay();
    redraw();
}

function startViewingPhase() {
    gameState = 'viewing';
    
    const gameStatus = document.getElementById('game-status');
    
    // Clear current drawing and show original
    allSquibbles = [...originalDrawing];
    redraw();
    
    if (currentDrawer === myPlayerId) {
        gameStatus.textContent = '⏳';
    } else {
        gameStatus.textContent = '👁️';
    }
    
    canvas.classList.add('watching');
    
    // Start 3 second viewing timer
    startTimer(3, () => {
        sendMessage('startRecreating', {});
        startRecreatingPhase();
    });
}

function startRecreatingPhase() {
    gameState = 'recreating';
    
    const gameStatus = document.getElementById('game-status');
    
    // Clear canvas for recreating
    allSquibbles = [];
    redraw();
    
    if (currentDrawer === myPlayerId) {
        gameStatus.textContent = '⏳';
        canvas.classList.add('watching');
    } else {
        gameStatus.textContent = '🎨';
        canvas.classList.remove('watching');
        
        // Start 10 second timer for recreating
        startTimer(10, () => {
            // Time's up - save recreation and submit
            myRecreation = [...allSquibbles];
            canvas.classList.add('watching');
            
            // Send my recreation to others
            sendMessage('recreationSubmitted', {
                playerId: myPlayerId,
                drawing: myRecreation
            });
            
            // Add my own recreation to local list
            const myRecreationObj = {
                playerId: myPlayerId,
                drawing: myRecreation,
                playerIcon: selectedIcon
            };
            const existingIndex = allRecreations.findIndex(r => r.playerId === myPlayerId);
            if (existingIndex === -1) {
                allRecreations.push(myRecreationObj);
            }
            
            // Update status to show waiting
            const gameStatus = document.getElementById('game-status');
            gameStatus.textContent = '⏳';
        });
    }
}

function showGallery() {
    gameState = 'gallery';
    
    // Hide canvas and timer
    canvas.style.display = 'none';
    const timerBar = document.getElementById('timer-bar');
    if (timerBar) timerBar.style.display = 'none';
    
    // Create or show gallery
    let gallery = document.getElementById('gallery');
    if (!gallery) {
        gallery = document.createElement('div');
        gallery.id = 'gallery';
        gallery.className = 'gallery';
        document.getElementById('game-screen').appendChild(gallery);
    }
    gallery.style.display = 'block';
    
    const gameStatus = document.getElementById('game-status');
    
    if (currentDrawer === myPlayerId) {
        gameStatus.textContent = '🗳️';
    } else {
        gameStatus.textContent = '🖼️';
    }
    
    // Show original drawing first
    gallery.innerHTML = `
        <div class="gallery-section">
            <canvas class="gallery-canvas original-canvas"></canvas>
        </div>
        <div class="gallery-section">
            <div class="recreations-grid"></div>
        </div>
    `;
    
    // Draw original on its canvas
    const originalCanvas = gallery.querySelector('.original-canvas');
    originalCanvas.width = 300;
    originalCanvas.height = 200;
    const originalCtx = originalCanvas.getContext('2d');
    drawDrawingOnCanvas(originalCtx, originalDrawing, 300, 200);
    
    // Show all recreations
    const recreationsGrid = gallery.querySelector('.recreations-grid');
    allRecreations.forEach(recreation => {
        const recreationDiv = document.createElement('div');
        recreationDiv.className = 'recreation-item';
        
        const recreationCanvas = document.createElement('canvas');
        recreationCanvas.width = 250;
        recreationCanvas.height = 167;
        recreationCanvas.className = 'gallery-canvas recreation-canvas';
        
        // Add click handler for voting (only for original drawer)
        if (currentDrawer === myPlayerId) {
            recreationCanvas.style.cursor = 'pointer';
            recreationCanvas.addEventListener('click', () => {
                // Send vote to everyone
                sendMessage('voteSubmitted', { winnerId: recreation.playerId });
                votedWinner = recreation.playerId;
                showVoteResult();
            });
        }
        
        const recreationCtx = recreationCanvas.getContext('2d');
        drawDrawingOnCanvas(recreationCtx, recreation.drawing, 250, 167);
        
        recreationDiv.innerHTML = `
            <div class="recreation-label">
                ${recreation.playerIcon}
            </div>
        `;
        recreationDiv.appendChild(recreationCanvas);
        
        recreationsGrid.appendChild(recreationDiv);
    });
}

function showVoteResult() {
    const gameStatus = document.getElementById('game-status');
    
    const winner = players.find(p => p.id === votedWinner);
    const winnerIcon = winner?.icon || '🎨';
    
    gameStatus.textContent = '🎉';
    
    // Highlight the winning recreation
    const recreationsGrid = document.querySelector('.recreations-grid');
    if (recreationsGrid) {
        const recreationItems = recreationsGrid.querySelectorAll('.recreation-item');
        recreationItems.forEach(item => {
            const canvas = item.querySelector('.recreation-canvas');
            const label = item.querySelector('.recreation-label');
            
            // Check if this is the winner's recreation
            if (label.textContent.includes(winnerIcon)) {
                canvas.style.border = '3px solid #28a745';
                canvas.style.boxShadow = '0 0 10px rgba(40, 167, 69, 0.5)';
                item.style.transform = 'scale(1.05)';
            } else {
                canvas.style.opacity = '0.6';
            }
        });
    }
    
    // Remove click handlers from all canvases
    const allCanvases = document.querySelectorAll('.recreation-canvas');
    allCanvases.forEach(canvas => {
        canvas.style.cursor = 'default';
        canvas.replaceWith(canvas.cloneNode(true));
    });
    
    // Start 5 second timer for next round
    startTimer(5, () => {
        startNextRound();
    });
}

function startNextRound() {
    // Get next drawer in order
    const currentIndex = players.findIndex(p => p.id === currentDrawer);
    const nextIndex = (currentIndex + 1) % players.length;
    const nextDrawer = players[nextIndex];
    
    // Send next round message
    sendMessage('nextRound', { drawer: nextDrawer.id });
    
    // Start the next round locally
    currentDrawer = nextDrawer.id;
    gameState = 'originalDrawing';
    startOriginalDrawing();
}

function drawDrawingOnCanvas(ctx, drawing, targetWidth, targetHeight) {
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    
    if (drawing.length === 0) return;
    
    // Find the bounding box of all strokes
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    
    drawing.forEach(strokeData => {
        strokeData.points.forEach(point => {
            minX = Math.min(minX, point[0]);
            minY = Math.min(minY, point[1]);
            maxX = Math.max(maxX, point[0]);
            maxY = Math.max(maxY, point[1]);
        });
    });
    
    // Add some padding
    const padding = 20;
    minX -= padding;
    minY -= padding;
    maxX += padding;
    maxY += padding;
    
    // Calculate the scale to fit within the target canvas
    const drawingWidth = maxX - minX;
    const drawingHeight = maxY - minY;
    const scaleX = targetWidth / drawingWidth;
    const scaleY = targetHeight / drawingHeight;
    const scale = Math.min(scaleX, scaleY); // Use the smaller scale to fit entirely
    
    // Calculate offset to center the drawing
    const scaledWidth = drawingWidth * scale;
    const scaledHeight = drawingHeight * scale;
    const offsetX = (targetWidth - scaledWidth) / 2;
    const offsetY = (targetHeight - scaledHeight) / 2;
    
    drawing.forEach(strokeData => {
        // Scale and translate points
        const scaledPoints = strokeData.points.map(point => [
            (point[0] - minX) * scale + offsetX,
            (point[1] - minY) * scale + offsetY
        ]);
        
        const stroke = getStroke(scaledPoints, {
            size: Math.max(strokeData.size * scale, 1), // Ensure minimum size
            thinning: strokeData.thinning,
            smoothing: strokeData.smoothing,
            streamline: strokeData.streamline
        });

        ctx.fillStyle = strokeData.color;
        ctx.beginPath();
        if (stroke.length > 0) {
            ctx.moveTo(stroke[0][0], stroke[0][1]);
            for (const [x, y] of stroke) {
                ctx.lineTo(x, y);
            }
        }
        ctx.closePath();
        ctx.fill();
    });
}

function updateWaitingDisplay() {
    const playersWaiting = document.getElementById('players-waiting');
    const startBtn = document.getElementById('start-btn');
    
    if (!playersWaiting) return;
    
    playersWaiting.innerHTML = '';
    players.forEach(player => {
        const playerDiv = document.createElement('div');
        playerDiv.className = 'player-waiting';
        if (player.id === myPlayerId) {
            playerDiv.classList.add('me');
        }
        
        playerDiv.innerHTML = `
            <span class="player-icon">${player.icon}</span>
        `;
        playersWaiting.appendChild(playerDiv);
    });
    
    // Enable start button if 3+ players
    if (startBtn) {
        startBtn.disabled = players.length < 3;
    }
}

function updatePlayersDisplay() {
    const playersBar = document.getElementById('players-bar');
    if (!playersBar) return;
    
    playersBar.innerHTML = '';
    
    players.forEach(player => {
        const playerDiv = document.createElement('div');
        playerDiv.className = 'player';
        
        // Highlight current drawer
        if (player.id === currentDrawer) {
            playerDiv.classList.add('drawing');
        }
        
        // Highlight yourself
        if (player.id === myPlayerId) {
            playerDiv.style.fontWeight = 'bold';
        }
        
        playerDiv.innerHTML = `
            <span class="player-icon">${player.icon}</span>
        `;
        playersBar.appendChild(playerDiv);
    });
}

function canDraw() {
    return (gameState === 'originalDrawing' && currentDrawer === myPlayerId) ||
           (gameState === 'recreating' && currentDrawer !== myPlayerId);
}

// Icon selection
document.querySelectorAll('.icon-option').forEach(iconEl => {
    iconEl.addEventListener('click', () => {
        document.querySelectorAll('.icon-option').forEach(el => el.classList.remove('selected'));
        iconEl.classList.add('selected');
        selectedIcon = iconEl.dataset.icon;
        const joinBtn = document.getElementById('join-btn');
        if (joinBtn) joinBtn.disabled = false;
    });
});

// Join button
document.getElementById('join-btn')?.addEventListener('click', () => {
    if (selectedIcon) {
        // Create a more unique ID by combining timestamp + random number
        myPlayerId = Date.now().toString() + '-' + Math.random().toString(36).substr(2, 9);
        
        // Add yourself to the local players list immediately
        players.push({ id: myPlayerId, icon: selectedIcon });
        
        // Switch to waiting screen
        document.getElementById('start-screen').style.display = 'none';
        document.getElementById('waiting-screen').style.display = 'flex';
        
        // Send join message to others
        sendMessage('playerJoined', { id: myPlayerId, icon: selectedIcon });
        
        updateWaitingDisplay();
    }
});

// Start game button - use predictable first drawer
document.getElementById('start-btn')?.addEventListener('click', () => {
    if (players.length >= 3) { // Changed from 2 to 3
        // Disable the button immediately to prevent double-clicks
        const startBtn = document.getElementById('start-btn');
        if (startBtn) {
            startBtn.disabled = true;
            startBtn.textContent = '⏳';
        }
        
        // Sort players by ID to ensure consistent order
        players.sort((a, b) => a.id.localeCompare(b.id));
        
        // Always pick the first player in the sorted list
        const firstDrawer = players[0];
        sendMessage('startGame', { drawer: firstDrawer.id });
    }
});

// Canvas setup
function resize() {
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight - 120; // Account for header + players bar
    redraw();
}
window.addEventListener('resize', resize);

// Drawing events
canvas?.addEventListener('pointerdown', e => {
    if (!canDraw()) return;
    drawing = true;
    points = [[e.clientX, e.clientY - 120]]; // Offset for header + players bar
});

canvas?.addEventListener('pointermove', e => {
    if (!drawing || !canDraw()) return;
    points.push([e.clientX, e.clientY - 120]);
    redraw();
});

canvas?.addEventListener('pointerup', () => {
    if (!canDraw() || points.length === 0) return;
    
    const strokeData = {
        points: [...points],
        color: drawColor,
        size, thinning, smoothing, streamline,
        playerId: myPlayerId
    };
    
    allSquibbles.push(strokeData);
    
    // Only send strokes during original drawing phase
    if (gameState === 'originalDrawing') {
        sendMessage('stroke', strokeData);
    }
    
    points = [];
    drawing = false;
    redraw();
});

function redraw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    allSquibbles.forEach(strokeData => {
        drawStroke(strokeData.points, strokeData);
    });

    if (points.length) {
        drawStroke(points, { color: drawColor, size, thinning, smoothing, streamline });
    }
}

function drawStroke(pts, settings) {
    const stroke = getStroke(pts, {
        size: settings.size,
        thinning: settings.thinning,
        smoothing: settings.smoothing,
        streamline: settings.streamline
    });

    ctx.fillStyle = settings.color;
    ctx.beginPath();
    if (stroke.length > 0) {
        ctx.moveTo(stroke[0][0], stroke[0][1]);
        for (const [x, y] of stroke) {
            ctx.lineTo(x, y);
        }
    }
    ctx.closePath();
    ctx.fill();
}

// Handle disconnection
window.addEventListener('beforeunload', () => {
    if (myPlayerId) {
        sendMessage('playerLeft', { id: myPlayerId });
    }
});

connectWebSocket();