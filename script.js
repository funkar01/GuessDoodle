document.addEventListener('DOMContentLoaded', () => {
    // --- URL Params & Redirect ---
    const urlParams = new URLSearchParams(window.location.search);
    const myName = urlParams.get('name');
    let isHost = urlParams.get('host') === 'true';
    const targetRoomId = urlParams.get('room');

    // Default to Host if no room provided
    if (myName && !targetRoomId && !isHost) {
        isHost = true;
    }

    if (!myName) {
        // Redirect to lobby if no name provided, but keep room ID if present
        if (targetRoomId) {
            window.location.href = `lobby.html?room=${targetRoomId}`;
        } else {
            window.location.href = 'lobby.html';
        }
        return;
    }

    // --- Canvas & Drawing Setup ---
    const canvas = document.getElementById('drawingCanvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const container = document.querySelector('.canvas-wrapper');

    // UI Elements
    const colorPicker = document.getElementById('colorPicker');
    const brushSizeInput = document.getElementById('brushSize');
    const btnDraw = document.getElementById('btnDraw');
    const btnErase = document.getElementById('btnErase');
    const btnUndo = document.getElementById('btnUndo');
    const btnClear = document.getElementById('btnClear');
    const connectionStatus = document.getElementById('connectionStatus');
    const roomDisplay = document.getElementById('roomDisplay');
    const currentRoomIdSpan = document.getElementById('currentRoomId');
    const btnCopyRoom = document.getElementById('btnCopyRoom');

    // State
    let isDrawing = false;
    let canDraw = false; // Permission to draw
    let currentTool = 'draw';
    let history = [];
    let historyStep = -1;
    const MAX_HISTORY = 50;
    let brushColor = colorPicker.value;
    let brushSize = parseInt(brushSizeInput.value);

    // Player State
    const players = {}; // { peerId: { name, isReady, conn } }
    let playerOrder = []; // [peerId, peerId, ...] - Chronological order
    let myPeerId = null;
    let isReady = false;
    let currentArtistId = null;
    let currentRivalId = null;

    // Networking State
    let peer = null;
    let connections = [];

    // Voice Chat State
    let localStream = null;
    let audioCalls = {}; // { peerId: MediaConnection }
    let isMuted = false;

    // Game State (Host Only)
    let gameTimer = null;
    let timeLeft = 60;
    let targetWord = '';
    let isGameRunning = false;

    // --- Initialization ---
    function resizeCanvas() {
        const width = container.clientWidth;
        const height = container.clientHeight;

        if (canvas.width !== width || canvas.height !== height) {
            let tempCanvas;
            if (canvas.width > 0 && canvas.height > 0) {
                tempCanvas = document.createElement('canvas');
                tempCanvas.width = canvas.width;
                tempCanvas.height = canvas.height;
                const tempCtx = tempCanvas.getContext('2d');
                tempCtx.drawImage(canvas, 0, 0);
            }

            canvas.width = width;
            canvas.height = height;

            if (tempCanvas) {
                ctx.drawImage(tempCanvas, 0, 0, width, height);
            } else {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                saveState();
            }
        }
    }

    const resizeObserver = new ResizeObserver(() => resizeCanvas());
    resizeObserver.observe(container);
    resizeCanvas();

    // --- Drawing Logic ---
    function getPos(e) {
        const rect = canvas.getBoundingClientRect();
        let clientX, clientY;

        if (e.touches) {
            clientX = e.touches[0].clientX;
            clientY = e.touches[0].clientY;
        } else {
            clientX = e.clientX;
            clientY = e.clientY;
        }

        return {
            x: clientX - rect.left,
            y: clientY - rect.top
        };
    }

    function startDraw(e) {
        if (!canDraw) return; // Enforce permission
        if (e.touches) e.preventDefault(); // Prevent scrolling
        isDrawing = true;
        const pos = getPos(e);
        performDraw(pos.x, pos.y, brushColor, brushSize, currentTool, true);
    }

    function draw(e) {
        if (!isDrawing) return;
        if (e.touches) e.preventDefault();
        const pos = getPos(e);
        performDraw(pos.x, pos.y, brushColor, brushSize, currentTool, true);
    }

    function endDraw() {
        if (!isDrawing) return;
        isDrawing = false;
        ctx.beginPath();
        broadcast({ type: 'endStroke' });
        saveState();
    }

    function performDraw(x, y, color, size, tool, emit) {
        ctx.lineWidth = size;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = tool === 'erase' ? '#ffffff' : color;

        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y);

        if (emit) {
            broadcast({
                type: 'draw',
                x: x / canvas.width,
                y: y / canvas.height,
                color: color,
                size: size,
                tool: tool
            });
        }
    }

    canvas.addEventListener('mousedown', startDraw);
    canvas.addEventListener('mousemove', draw);
    canvas.addEventListener('mouseup', endDraw);
    canvas.addEventListener('mouseout', endDraw);

    canvas.addEventListener('touchstart', startDraw, { passive: false });
    canvas.addEventListener('touchmove', draw, { passive: false });
    canvas.addEventListener('touchend', endDraw);

    // --- Tools Logic ---
    colorPicker.addEventListener('input', (e) => {
        brushColor = e.target.value;
        if (currentTool === 'draw') {
            ctx.strokeStyle = brushColor;
        }
    });

    brushSizeInput.addEventListener('input', (e) => {
        brushSize = parseInt(e.target.value);
    });

    btnDraw.addEventListener('click', () => {
        currentTool = 'draw';
        btnDraw.classList.add('active');
        btnErase.classList.remove('active');
        brushColor = colorPicker.value;
    });

    btnErase.addEventListener('click', () => {
        currentTool = 'erase';
        btnErase.classList.add('active');
        btnDraw.classList.remove('active');
    });

    // --- History Logic ---
    function saveState() {
        if (historyStep < history.length - 1) {
            history = history.slice(0, historyStep + 1);
        }
        history.push(canvas.toDataURL());
        if (history.length > MAX_HISTORY) {
            history.shift();
        } else {
            historyStep++;
        }
    }

    function restoreState(imgSrc) {
        const img = new Image();
        img.src = imgSrc;
        img.onload = () => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        };
    }

    btnUndo.addEventListener('click', () => {
        if (historyStep > 0) {
            historyStep--;
            const previousState = history[historyStep];
            restoreState(previousState);
            broadcast({ type: 'undo' });
        }
    });

    // --- Clear Logic ---
    function clearCanvas() {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        history = [];
        historyStep = -1;
        saveState();
    }

    btnClear.addEventListener('click', () => {
        clearCanvas();
        broadcast({ type: 'clear' });
    });

    // --- Ready System ---
    const btnReady = document.getElementById('btnReady');

    btnReady.addEventListener('click', () => {
        if (isReady) return; // Cannot un-ready for now

        isReady = true;
        btnReady.classList.add('ready');
        btnReady.textContent = 'Ready!';

        // Notify Host (or everyone if I am host, logic handled in broadcast)
        if (isHost) {
            handlePlayerReady(myPeerId);
        } else {
            // Send to Host
            if (connections.length > 0) {
                connections[0].send({ type: 'ready', peerId: myPeerId });
            }
        }
    });

    function handlePlayerReady(peerId) {
        if (!players[peerId]) return;
        players[peerId].isReady = true;

        // Check if everyone is ready (Host only)
        if (isHost) {
            checkAllReady();
            broadcastPlayerList(); // Update ready status in list
        } else {
            // If client, we just sent ready. Host will broadcast list update eventually.
            // But we can update local state for ourselves immediately if we want, 
            // though waiting for host is safer for consistency.
        }
    }

    function broadcastPlayerList() {
        const list = playerOrder.map(id => ({
            id: id,
            name: players[id] ? players[id].name : 'Unknown',
            isReady: players[id] ? players[id].isReady : false,
            score: players[id] ? (players[id].score || 0) : 0,
            isHost: id === myPeerId // Host is always me since I am broadcasting
        }));
        broadcast({ type: 'updatePlayerList', list: list });
        renderPlayerList(list); // Render for host too
    }

    function renderPlayerList(list) {
        const container = document.getElementById('playerListContainer');
        if (!container) return;
        container.innerHTML = '';

        list.forEach(p => {
            const div = document.createElement('div');
            div.className = `player-item ${p.id === myPeerId ? 'is-me' : ''} ${p.isReady ? 'ready' : ''}`;

            // Status Dot
            const dot = document.createElement('div');
            dot.className = 'status-dot';
            div.appendChild(dot);

            // Name
            const nameSpan = document.createElement('span');
            const score = p.score !== undefined ? p.score : 0;
            nameSpan.textContent = `${p.name} (${score} pts)${p.id === myPeerId ? ' (You)' : ''}`;
            div.appendChild(nameSpan);

            container.appendChild(div);
        });
    }

    function checkAllReady() {
        const allReady = Object.values(players).every(p => p.isReady);
        if (allReady && Object.keys(players).length > 1) { // Need at least 2 players
            // Determine Winners (Host Authority)
            const allIds = Object.keys(players);

            // 1. Pick Rival
            const rivalIndex = Math.floor(Math.random() * allIds.length);
            const rivalId = allIds[rivalIndex];

            // 2. Pick Artist (Must be different if possible)
            let artistId = rivalId;

            if (allIds.length > 1) {
                const potentialArtists = allIds.filter(id => id !== rivalId);
                const artistIndex = Math.floor(Math.random() * potentialArtists.length);
                artistId = potentialArtists[artistIndex];
            }

            const spinData = {
                type: 'startSpinSequence',
                rival: { id: rivalId, name: players[rivalId].name },
                artist: { id: artistId, name: players[artistId].name },
                allNames: allIds.map(id => players[id].name)
            };

            broadcast(spinData);
            handleSpinSequence(spinData); // Host also runs it
        }
    }

    function handleSpinSequence(data) {
        currentRivalId = data.rival.id;
        currentArtistId = data.artist.id;
        canDraw = false; // Reset permission for everyone
        updateToolbarState();

        // Hide previous word display & overlays
        document.getElementById('targetWordDisplay').style.display = 'none';
        document.getElementById('gameOverOverlay').style.display = 'none';
        document.getElementById('guessContainer').style.display = 'none';
        document.getElementById('chatLog').innerHTML = ''; // Clear chat

        // Reset Timer UI
        document.getElementById('gameTimer').textContent = '60s';
        document.getElementById('gameTimer').style.display = 'none';

        // 1. Spin for Rival
        startSpin(data.allNames, 'Selecting Rival...', data.rival.name, () => {
            // Update UI for Rival
            const roleDisplay = document.getElementById('roleDisplay');
            const rivalNameEl = document.getElementById('rivalName');
            roleDisplay.style.display = 'flex';
            rivalNameEl.textContent = data.rival.name;

            // 2. Wait
            setTimeout(() => {
                // 3. Spin for Artist
                // Remove Rival from artist pool for visual clarity
                const artistPool = data.allNames.filter(n => n !== data.rival.name);

                startSpin(artistPool, 'Selecting Artist...', data.artist.name, () => {
                    // Update UI for Artist
                    const artistNameEl = document.getElementById('artistName');
                    artistNameEl.textContent = data.artist.name;

                    // Final State
                    setTimeout(() => {
                        document.getElementById('wheelOverlay').style.display = 'none';
                        // Start Word Selection Phase
                        startWordSelection(data.rival.id, data.artist.id);
                    }, 2000);
                });
            }, 2000);
        });
    }

    function startWordSelection(rivalId, artistId) {
        const wordInputOverlay = document.getElementById('wordInputOverlay');
        const gameMessageOverlay = document.getElementById('gameMessageOverlay');
        const gameMessageText = document.getElementById('gameMessageText');
        const btnSendWord = document.getElementById('btnSendWord');
        const wordInput = document.getElementById('wordInput');

        // Store roles globally or pass them? 
        // We can just check IDs.

        if (myPeerId === rivalId) {
            // I am the Rival
            wordInputOverlay.style.display = 'flex';
            wordInput.value = ''; // Clear previous input
            wordInput.focus();

            // Add one-time listener or ensure it's not duplicated?
            // Better to add it once globally, but here is easier for context if we remove it later.
            // Actually, let's add it globally at the bottom with other listeners to avoid duplicates.
        } else {
            // I am Artist or Guesser
            gameMessageOverlay.style.display = 'flex';
            gameMessageText.textContent = "Waiting for Rival to choose a word...";
        }
    }

    // Word Selection Logic
    const btnSendWord = document.getElementById('btnSendWord');
    if (btnSendWord) {
        btnSendWord.addEventListener('click', () => {
            const wordInput = document.getElementById('wordInput');
            const word = wordInput.value.trim();
            if (word) {
                const data = { type: 'wordSelected', word: word };
                broadcast(data);
                handleWordSelected(word); // Local update

                // Host starts timer
                if (isHost) {
                    startTimer(word);
                }
            }
        });
    }

    function handleWordSelected(word) {
        console.log('handleWordSelected called with:', word);
        console.log('My Peer ID:', myPeerId);
        console.log('Current Artist ID:', currentArtistId);
        console.log('Current Rival ID:', currentRivalId);
        console.log('Am I Artist?', myPeerId === currentArtistId);

        const wordInputOverlay = document.getElementById('wordInputOverlay');
        const gameMessageOverlay = document.getElementById('gameMessageOverlay');
        const targetWordDisplay = document.getElementById('targetWordDisplay');
        const guessContainer = document.getElementById('guessContainer');
        const gameTimerEl = document.getElementById('gameTimer');

        wordInputOverlay.style.display = 'none';
        gameMessageOverlay.style.display = 'none'; // Hide waiting message

        // Show Timer
        gameTimerEl.style.display = 'flex';

        // Show persistent display for Artist
        if (myPeerId === currentArtistId) {
            console.log('Showing word to Artist');
            targetWordDisplay.style.display = 'flex';
            targetWordDisplay.innerHTML = `Doodle this: <span>${word}</span>`;
            canDraw = true;
            guessContainer.style.display = 'none'; // Artist doesn't guess
        } else if (myPeerId === currentRivalId) {
            console.log('Hiding word for Rival');
            targetWordDisplay.style.display = 'none';
            canDraw = false;
            guessContainer.style.display = 'none'; // Rival doesn't guess
        } else {
            console.log('Hiding word for Guesser');
            // Guessers
            targetWordDisplay.style.display = 'none';
            canDraw = false;
            guessContainer.style.display = 'flex'; // Show chat/guess box
        }
        updateToolbarState();
    }

    // --- Timer & Game Logic (Host) ---
    function startTimer(word) {
        targetWord = word;
        timeLeft = 60;
        isGameRunning = true;

        if (gameTimer) clearInterval(gameTimer);

        gameTimer = setInterval(() => {
            if (!isGameRunning) {
                clearInterval(gameTimer);
                return;
            }

            timeLeft--;
            broadcast({ type: 'timerUpdate', time: timeLeft });
            updateTimerUI(timeLeft);

            if (timeLeft <= 0) {
                if (players[currentRivalId]) players[currentRivalId].score = (players[currentRivalId].score || 0) + 1;
                broadcastPlayerList(); // Update scores for everyone
                endGame('rival', 'Time\'s up!');
            }
        }, 1000);
    }

    function endGame(winner, reason, winnerName = '') {
        isGameRunning = false;
        clearInterval(gameTimer);

        const data = {
            type: 'gameOver',
            winner: winner,
            reason: reason,
            word: targetWord,
            winnerName: winnerName
        };
        broadcast(data);
        handleGameOver(data);
    }

    function handleGameOver(data) {
        const overlay = document.getElementById('gameOverOverlay');
        const title = document.getElementById('gameOverTitle');
        const reason = document.getElementById('gameOverReason');
        const revealedWord = document.getElementById('revealedWord');
        const btnNewRound = document.getElementById('btnNewRound');

        overlay.style.display = 'flex';
        reason.textContent = data.reason;
        revealedWord.textContent = data.word;

        if (data.winner === 'artist') {
            title.textContent = 'Artist Wins!';
            title.style.color = 'var(--success-color)';
        } else {
            title.textContent = 'Rival Wins!';
            title.style.color = 'var(--danger-color)';
        }

        // Trigger Effects
        playWinSound();
        triggerConfetti();

        // Only Host can start new round
        if (isHost) {
            btnNewRound.style.display = 'inline-block';
        } else {
            btnNewRound.style.display = 'none';
        }

        canDraw = false;
        updateToolbarState();
    }

    function updateTimerUI(time) {
        const el = document.getElementById('gameTimer');
        el.textContent = time + 's';
        if (time <= 10) {
            el.style.color = 'var(--danger-color)';
        } else {
            el.style.color = 'var(--warning-color)';
        }
    }

    // --- Guessing Logic ---
    const btnGuess = document.getElementById('btnGuess');
    const guessInput = document.getElementById('guessInput');

    if (btnGuess) {
        btnGuess.addEventListener('click', sendGuess);
        guessInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendGuess();
        });
    }

    function sendGuess() {
        const guess = guessInput.value.trim();
        if (!guess) return;

        // Send to Host
        if (isHost) {
            processGuess(myPeerId, guess);
        } else {
            if (connections.length > 0) {
                connections[0].send({ type: 'submitGuess', guess: guess, peerId: myPeerId });
            }
        }
        guessInput.value = '';
    }

    function processGuess(peerId, guess) {
        if (!isGameRunning) return;

        const playerName = players[peerId] ? players[peerId].name : 'Unknown';

        // Check match
        if (guess.toLowerCase() === targetWord.toLowerCase()) {
            // Artist Wins
            if (players[currentArtistId]) players[currentArtistId].score = (players[currentArtistId].score || 0) + 1;
            if (players[peerId]) players[peerId].score = (players[peerId].score || 0) + 1;
            broadcastPlayerList(); // Update scores for everyone
            endGame('artist', `${playerName} guessed correctly!`, playerName);
        } else {
            // Broadcast chat message
            const chatData = { type: 'chatMessage', name: playerName, message: guess };
            broadcast(chatData);
            addChatMessage(playerName, guess);
        }
    }

    function addChatMessage(name, message, type = 'normal') {
        const chatLog = document.getElementById('chatLog');
        const div = document.createElement('div');
        div.className = `chat-message ${type}`;

        if (type === 'system') {
            div.textContent = message;
        } else {
            div.textContent = `${name}: ${message}`;
        }

        chatLog.appendChild(div);
        chatLog.scrollTop = chatLog.scrollHeight;
    }

    // New Round Button
    const btnNewRound = document.getElementById('btnNewRound');
    if (btnNewRound) {
        btnNewRound.addEventListener('click', () => {
            checkAllReady(); // Restart spin sequence
        });
    }

    function updateToolbarState() {
        const toolbar = document.querySelector('.toolbar');
        if (canDraw) {
            toolbar.classList.remove('disabled');
        } else {
            toolbar.classList.add('disabled');
        }
    }

    // --- Networking (PeerJS) ---
    if (isHost || targetRoomId) {
        connectionStatus.style.display = 'inline-block';
        connectionStatus.textContent = 'Connecting...';

        // Initialize Peer
        peer = new Peer(null, { debug: 2 });

        peer.on('open', (id) => {
            console.log('My ID: ' + id);
            myPeerId = id;

            // Register myself
            players[id] = { name: myName, isReady: false, score: 0 };
            playerOrder.push(id);

            if (isHost) {
                renderPlayerList([{ id: id, name: myName, isReady: false, isHost: true }]);
            }

            if (isHost) {
                // Host Mode: Display ID
                roomDisplay.style.display = 'inline-flex';
                currentRoomIdSpan.textContent = id;
                connectionStatus.textContent = 'Online (Host)';
                connectionStatus.classList.add('online');
                initAudio(); // Host initializes audio immediately
            } else if (targetRoomId) {
                // Join Mode: Connect to Host
                const conn = peer.connect(targetRoomId);
                handleConnection(conn);
            }
        });

        peer.on('connection', (conn) => {
            // Incoming connection (Host receives Joiner)
            handleConnection(conn);
        });

        peer.on('error', (err) => {
            console.error(err);
            alert('Connection Error: ' + err.type);
            connectionStatus.textContent = 'Error';
        });

        peer.on('call', (call) => {
            handleIncomingCall(call);
        });
    }

    function handleConnection(conn) {
        connections.push(conn);

        conn.on('open', () => {
            connectionStatus.textContent = `Online (${connections.length + 1})`;
            connectionStatus.classList.add('online');

            // Send Join Info
            conn.send({ type: 'join', name: myName, peerId: myPeerId });

            // If I am host, send state to new peer
            if (isHost) {
                conn.send({
                    type: 'syncState',
                    image: canvas.toDataURL()
                });
                // Also send current player list immediately
                broadcastPlayerList();
            }
        });

        conn.on('data', (data) => {
            handleData(data, conn);
            // Relay if Host (except specific types)
            if (isHost && data.type !== 'join' && data.type !== 'ready') {
                broadcast(data, conn.peer);
            }
        });

        conn.on('close', () => {
            connections = connections.filter(c => c.peer !== conn.peer);
            connections = connections.filter(c => c.peer !== conn.peer);
            delete players[conn.peer]; // Remove player
            playerOrder = playerOrder.filter(id => id !== conn.peer);

            if (isHost) {
                broadcastPlayerList();
            }

            connectionStatus.textContent = `Online (${connections.length + 1})`;
        });
    }

    function handleData(data, conn) {
        switch (data.type) {
            case 'syncState':
                restoreState(data.image);
                history = [data.image];
                historyStep = 0;
                break;
            case 'join':
                // Host handles join logic in handleConnection mostly, but we need to catch the name here
                if (isHost) {
                    if (!players[data.peerId]) {
                        players[data.peerId] = { name: data.name, isReady: false, score: 0 };
                        playerOrder.push(data.peerId);
                        broadcastPlayerList();
                    }
                }
                break;
            case 'updatePlayerList':
                renderPlayerList(data.list);
                // Update local players map for non-hosts to have names
                data.list.forEach(p => {
                    if (p.id !== myPeerId) {
                        players[p.id] = { name: p.name, isReady: p.isReady, score: p.score };
                    }
                });
                updateAudioMesh(data.list);
                break;
            case 'ready':
                // Only Host needs to handle this to track readiness
                if (isHost) {
                    handlePlayerReady(data.peerId);
                }
                break;
            case 'startSpinSequence':
                handleSpinSequence(data);
                break;
            case 'wordSelected':
                handleWordSelected(data.word);
                // If I am Host (and not the Rival who sent it, though Rival sends to Host via broadcast logic? No, Rival calls broadcast)
                // Wait, if Rival is Host, they call startTimer locally.
                // If Rival is Client, they send 'wordSelected' to Host.
                // Host receives it here.
                if (isHost && myPeerId !== currentRivalId) {
                    startTimer(data.word);
                }
                break;
            case 'timerUpdate':
                updateTimerUI(data.time);
                break;
            case 'submitGuess':
                if (isHost) {
                    processGuess(data.peerId, data.guess);
                }
                break;
            case 'chatMessage':
                addChatMessage(data.name, data.message);
                break;
            case 'gameOver':
                handleGameOver(data);
                break;
            case 'draw':
                performDraw(data.x * canvas.width, data.y * canvas.height, data.color, data.size, data.tool, false);
                break;
            case 'endStroke':
                ctx.beginPath();
                break;
            case 'undo':
                // For now, undo is local-only or complex to sync perfectly without full history.
                // But if we want to support it, we'd need to broadcast undo and everyone pops history.
                // Simplified: just ignore or implement if needed.
                // Let's implement a basic version if we receive it:
                if (historyStep > 0) {
                    historyStep--;
                    restoreState(history[historyStep]);
                }
                break;
            case 'clear':
                clearCanvas();
                break;
        }
    }

    function broadcast(data, excludePeerId = null) {
        connections.forEach(conn => {
            if (conn.open && conn.peer !== excludePeerId) {
                conn.send(data);
            }
        });
    }



    // --- Expose for Debugging (Optional, can be removed in prod) ---
    // window.debugGame = { ... };

    // Copy ID Button
    if (btnCopyRoom) {
        btnCopyRoom.addEventListener('click', () => {
            navigator.clipboard.writeText(currentRoomIdSpan.textContent);
            const original = btnCopyRoom.textContent;
            btnCopyRoom.textContent = '✅';
            setTimeout(() => btnCopyRoom.textContent = original, 2000);
        });
    }

    // Share Button
    const btnShareRoom = document.getElementById('btnShareRoom');
    if (btnShareRoom) {
        btnShareRoom.addEventListener('click', async () => {
            const roomId = currentRoomIdSpan.textContent;
            // Construct a join link. Assuming the user wants to share a link to the lobby or direct join.
            // Direct join link: index.html?room=ROOMID (user still needs to enter name, but we can handle that)
            // Or lobby.html?room=ROOMID if we update lobby to accept it.
            // Let's point to lobby.html so they can enter their name.

            const origin = window.location.origin + window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/'));
            const shareUrl = `${origin}/lobby.html?room=${roomId}`;

            const shareData = {
                title: 'Join my GuessDoodle Room!',
                text: `Join my drawing room! ID: ${roomId}`,
                url: shareUrl
            };

            try {
                if (navigator.share) {
                    await navigator.share(shareData);
                } else {
                    // Fallback to clipboard
                    await navigator.clipboard.writeText(shareUrl);
                    const original = btnShareRoom.textContent;
                    btnShareRoom.textContent = '✅ Link Copied';
                    setTimeout(() => btnShareRoom.textContent = original, 2000);
                }
            } catch (err) {
                console.error('Error sharing:', err);
            }
        });
    }

    // --- Spinning Wheel Logic ---
    const wheelOverlay = document.getElementById('wheelOverlay');
    const wheelCanvas = document.getElementById('wheelCanvas');
    const wheelCtx = wheelCanvas.getContext('2d');
    const rivalResult = document.getElementById('rivalResult');
    const btnCloseWheel = document.getElementById('btnCloseWheel');

    const wheelTitle = document.querySelector('.wheel-container h2');

    function startSpin(names, title, targetName, callback) {
        wheelOverlay.style.display = 'flex';
        wheelTitle.textContent = title;
        rivalResult.textContent = ''; // Clear previous result
        btnCloseWheel.style.display = 'none';

        // Draw initial wheel
        drawWheel(names, 0);

        // Start spinning after a short delay
        setTimeout(() => {
            spinWheel(names, targetName, callback);
        }, 500);
    }

    function drawWheel(names, rotation) {
        const cx = wheelCanvas.width / 2;
        const cy = wheelCanvas.height / 2;
        const radius = wheelCanvas.width / 2 - 10;
        const step = (2 * Math.PI) / names.length;

        wheelCtx.clearRect(0, 0, wheelCanvas.width, wheelCanvas.height);

        wheelCtx.save();
        wheelCtx.translate(cx, cy);
        wheelCtx.rotate(rotation);

        names.forEach((name, i) => {
            const angle = i * step;

            // Slice
            wheelCtx.beginPath();
            wheelCtx.moveTo(0, 0);
            wheelCtx.arc(0, 0, radius, angle, angle + step);
            wheelCtx.closePath();

            // Colors (matching the provided image)
            // Green, Purple, Red, Dark Red, Lime, Magenta, Blue, Yellow
            const colors = ['#448D26', '#6200EA', '#FF0000', '#A81212', '#8BC34A', '#D500F9', '#0277BD', '#FFC107'];
            wheelCtx.fillStyle = colors[i % colors.length];
            wheelCtx.fill();
            wheelCtx.stroke();

            // Text
            wheelCtx.save();
            wheelCtx.rotate(angle + step / 2);
            wheelCtx.textAlign = 'right';
            wheelCtx.fillStyle = '#fff';
            wheelCtx.font = 'bold 16px Outfit';
            wheelCtx.shadowColor = 'rgba(0,0,0,0.5)';
            wheelCtx.shadowBlur = 4;
            wheelCtx.fillText(name, radius - 20, 5);
            wheelCtx.restore();
        });

        wheelCtx.restore();

        // Center circle "Rival"
        wheelCtx.beginPath();
        wheelCtx.arc(cx, cy, 40, 0, 2 * Math.PI);
        wheelCtx.fillStyle = '#fff';
        wheelCtx.fill();
        wheelCtx.lineWidth = 8;
        wheelCtx.strokeStyle = '#808080'; // Thick grey border
        wheelCtx.stroke();
        wheelCtx.lineWidth = 1; // Reset

        wheelCtx.fillStyle = '#333';
        wheelCtx.font = 'bold 20px Outfit';
        wheelCtx.textAlign = 'center';
        wheelCtx.textBaseline = 'middle';
        wheelCtx.fillText('Rival', cx, cy);
    }

    function spinWheel(names, targetName, callback) {
        let rotation = 0;
        let speed = 0.5;
        let deceleration = 0.005;
        let isSpinning = true;

        // Calculate target rotation to land on targetName
        // The pointer is at 0 (3 o'clock).
        // We want the slice for targetName to be at 0 when we stop.
        // Slice index:
        const targetIndex = names.indexOf(targetName);
        if (targetIndex === -1) {
            console.error('Target name not found in list!');
            isSpinning = false;
            if (callback) callback();
            return;
        }

        const step = (2 * Math.PI) / names.length;
        // The angle of the start of the target slice is targetIndex * step.
        // The center of the slice is targetIndex * step + step / 2.
        // We want this center to be at 0 (or 2PI).
        // Current rotation shifts the wheel. 
        // Visual angle = (sliceAngle + rotation) % 2PI.
        // We want (centerAngle + rotation) % 2PI = 0.
        // => rotation = -centerAngle.
        // We want to do multiple full spins (e.g. 5) + this offset.

        const centerAngle = targetIndex * step + step / 2;
        // Adjust for top pointer (-90deg or -PI/2)
        const targetRotation = (10 * Math.PI) - centerAngle - (Math.PI / 2);

        // We need to animate from 0 to targetRotation.
        // Using a simple ease-out would be better than physics loop for deterministic targeting.

        const startTime = performance.now();
        const duration = 4000; // 4 seconds

        function animate(currentTime) {
            const elapsed = currentTime - startTime;
            const progress = Math.min(elapsed / duration, 1);

            // Ease Out Cubic
            const ease = 1 - Math.pow(1 - progress, 3);

            rotation = targetRotation * ease;

            drawWheel(names, rotation);

            if (progress < 1) {
                requestAnimationFrame(animate);
            } else {
                // Finished
                rivalResult.textContent = `Selected: ${targetName}`;
                // btnCloseWheel.style.display = 'inline-block'; // Don't show close button in sequence
                if (callback) callback();
            }
        }

        requestAnimationFrame(animate);
    }

    updateToolbarState();

    // --- Sound & Particle Effects ---
    function playWinSound() {
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;

            const ctx = new AudioContext();
            const now = ctx.currentTime;

            // Simple major arpeggio: C5, E5, G5, C6
            const notes = [523.25, 659.25, 783.99, 1046.50];

            notes.forEach((freq, i) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();

                osc.type = 'sine';
                osc.frequency.value = freq;

                gain.gain.setValueAtTime(0.1, now + i * 0.1);
                gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.1 + 0.5);

                osc.connect(gain);
                gain.connect(ctx.destination);

                osc.start(now + i * 0.1);
                osc.stop(now + i * 0.1 + 0.5);
            });
        } catch (e) {
            console.error('Audio play failed', e);
        }
    }

    function triggerConfetti() {
        const canvas = document.createElement('canvas');
        canvas.style.position = 'fixed';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.pointerEvents = 'none';
        canvas.style.zIndex = '9999';
        document.body.appendChild(canvas);

        const ctx = canvas.getContext('2d');
        let width = window.innerWidth;
        let height = window.innerHeight;
        canvas.width = width;
        canvas.height = height;

        const particles = [];
        const colors = ['#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#00FFFF', '#FF00FF'];

        for (let i = 0; i < 100; i++) {
            particles.push({
                x: width / 2,
                y: height / 2,
                vx: (Math.random() - 0.5) * 10,
                vy: (Math.random() - 0.5) * 10 - 5, // Upward bias
                color: colors[Math.floor(Math.random() * colors.length)],
                size: Math.random() * 5 + 2,
                life: 100
            });
        }

        function animate() {
            ctx.clearRect(0, 0, width, height);
            let active = false;

            particles.forEach(p => {
                if (p.life > 0) {
                    active = true;
                    p.x += p.vx;
                    p.y += p.vy;
                    p.vy += 0.2; // Gravity
                    p.life--;

                    ctx.fillStyle = p.color;
                    ctx.globalAlpha = p.life / 100;
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                    ctx.fill();
                }
            });

            if (active) {
                requestAnimationFrame(animate);
            } else {
                document.body.removeChild(canvas);
            }
        }

        animate();
    }

    // --- Voice Chat Logic ---
    const btnMute = document.getElementById('btnMute');
    const iconMic = document.getElementById('iconMic');
    const iconMicOff = document.getElementById('iconMicOff');

    if (btnMute) {
        btnMute.addEventListener('click', toggleMute);
    }

    async function initAudio() {
        if (localStream) return;
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            // Initially mute if desired, or keep open. Let's keep open but allow mute.
            // But we need to update UI to show mic is active.
            if (btnMute) btnMute.style.display = 'inline-flex';
        } catch (err) {
            console.error('Failed to get local audio stream', err);
            alert('Could not access microphone. Voice chat will be disabled.');
        }
    }

    function toggleMute() {
        if (!localStream) {
            initAudio().then(() => {
                // If we just initialized, we might want to mute immediately if that was the intent,
                // but usually clicking mute means "I want to mute/unmute".
                // If we weren't initialized, we are now unmuted (default).
                // So if we want to toggle, we should check state.
            });
            return;
        }

        isMuted = !isMuted;
        localStream.getAudioTracks().forEach(track => track.enabled = !isMuted);

        if (isMuted) {
            btnMute.classList.add('muted');
            iconMic.style.display = 'none';
            iconMicOff.style.display = 'block';
        } else {
            btnMute.classList.remove('muted');
            iconMic.style.display = 'block';
            iconMicOff.style.display = 'none';
        }
    }

    function handleIncomingCall(call) {
        console.log('Incoming call from', call.peer);
        // Answer automatically with our stream (if we have one, or empty if not ready?)
        // Better to ensure we have a stream or answer with audio only.

        if (!localStream) {
            // If we don't have a stream yet, try to get one, or answer without stream (listen only mode?)
            // PeerJS requires a stream to answer if we want two-way.
            // Let's try to get stream quickly.
            navigator.mediaDevices.getUserMedia({ audio: true, video: false })
                .then(stream => {
                    localStream = stream;
                    if (btnMute) btnMute.style.display = 'inline-flex';
                    call.answer(localStream);
                    setupCallEvents(call);
                })
                .catch(err => {
                    console.error('Could not get stream to answer call', err);
                    call.answer(); // Answer receive-only?
                    setupCallEvents(call);
                });
        } else {
            call.answer(localStream);
            setupCallEvents(call);
        }
    }

    function connectToAudioPeer(peerId) {
        if (!localStream || audioCalls[peerId]) return;

        console.log('Calling peer for audio:', peerId);
        const call = peer.call(peerId, localStream);
        setupCallEvents(call);
        audioCalls[peerId] = call;
    }

    function setupCallEvents(call) {
        call.on('stream', (remoteStream) => {
            console.log('Received remote stream from', call.peer);
            // Play stream
            // Check if audio element exists for this peer
            let audio = document.getElementById(`audio-${call.peer}`);
            if (!audio) {
                audio = document.createElement('audio');
                audio.id = `audio-${call.peer}`;
                audio.autoplay = true;
                document.body.appendChild(audio);
            }
            audio.srcObject = remoteStream;
        });

        call.on('close', () => {
            console.log('Call closed with', call.peer);
            const audio = document.getElementById(`audio-${call.peer}`);
            if (audio) audio.remove();
            delete audioCalls[call.peer];
        });

        call.on('error', (err) => {
            console.error('Call error:', err);
        });
    }

    function updateAudioMesh(playerList) {
        // Simple Mesh: Connect to everyone we are not connected to.
        // To avoid duplicate calls, we can use a convention: Lower ID calls Higher ID.
        // Or just check if we have a call.

        if (!localStream) {
            // Try to init audio if we are in a room
            initAudio().then(() => {
                updateAudioMesh(playerList);
            });
            return;
        }

        playerList.forEach(p => {
            if (p.id !== myPeerId) {
                // If we don't have a call with them
                if (!audioCalls[p.id]) {
                    // Convention: I call them if my ID < their ID (lexicographical)
                    // This prevents double calling.
                    if (myPeerId < p.id) {
                        connectToAudioPeer(p.id);
                    }
                }
            }
        });
    }

});
