// Create falling brains animation
function createFallingBrains() {
    const container = document.getElementById('brainsContainer');
    const brainEmoji = '🧠';
    
    // Create initial brains
    function createBrain() {
        const brain = document.createElement('div');
        brain.className = 'brain';
        brain.textContent = brainEmoji;
        
        // Random horizontal position
        const leftPosition = Math.random() * 100;
        brain.style.left = leftPosition + '%';
        
        // Random delay for staggered effect
        const delay = Math.random() * 2;
        brain.style.animationDelay = delay + 's';
        
        // Random size variation
        const size = 1.5 + Math.random() * 1;
        brain.style.fontSize = size + 'rem';
        
        container.appendChild(brain);
        
        // Remove brain after animation completes
        setTimeout(() => {
            if (brain.parentNode) {
                brain.parentNode.removeChild(brain);
            }
        }, 6000);
    }
    
    // Create brains continuously
    function spawnBrains() {
        createBrain();
        // Spawn a new brain every 300-800ms
        const nextSpawn = 300 + Math.random() * 500;
        setTimeout(spawnBrains, nextSpawn);
    }
    
    // Start spawning brains
    spawnBrains();
    
    // Create initial batch of brains
    for (let i = 0; i < 10; i++) {
        setTimeout(() => createBrain(), i * 200);
    }
}

// Initialize when page loads
document.addEventListener('DOMContentLoaded', createFallingBrains);
