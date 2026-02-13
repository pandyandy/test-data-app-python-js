// Chart.js configuration
Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif';
Chart.defaults.font.size = 12;
Chart.defaults.color = '#718096';

// Color palette
const colors = {
    primary: '#667eea',
    secondary: '#764ba2',
    success: '#48bb78',
    warning: '#ed8936',
    danger: '#f56565',
    info: '#4299e1',
    gradient: ['#667eea', '#764ba2', '#f093fb', '#4facfe', '#43e97b']
};

let salesChart, usersChart, revenueChart;

// Initialize dashboard
document.addEventListener('DOMContentLoaded', async () => {
    await loadDashboard();
    // Refresh data every 30 seconds
    setInterval(loadDashboard, 30000);
});

async function loadDashboard() {
    try {
        const [salesData, usersData, revenueData] = await Promise.all([
            fetch('/api/data/sales').then(r => r.json()),
            fetch('/api/data/users').then(r => r.json()),
            fetch('/api/data/revenue').then(r => r.json())
        ]);

        updateSalesChart(salesData);
        updateUsersChart(usersData);
        updateRevenueChart(revenueData);
        updateStats(salesData, usersData, revenueData);
    } catch (error) {
        console.error('Error loading dashboard:', error);
    }
}

function updateSalesChart(data) {
    const ctx = document.getElementById('salesChart').getContext('2d');
    
    if (salesChart) {
        salesChart.destroy();
    }

    salesChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.map(d => d.month),
            datasets: [{
                label: 'Sales ($)',
                data: data.map(d => d.sales),
                borderColor: colors.primary,
                backgroundColor: 'rgba(102, 126, 234, 0.1)',
                borderWidth: 3,
                fill: true,
                tension: 0.4,
                pointRadius: 5,
                pointHoverRadius: 7,
                pointBackgroundColor: colors.primary,
                pointBorderColor: '#fff',
                pointBorderWidth: 2
            }, {
                label: 'Orders',
                data: data.map(d => d.orders),
                borderColor: colors.secondary,
                backgroundColor: 'rgba(118, 75, 162, 0.1)',
                borderWidth: 3,
                fill: true,
                tension: 0.4,
                pointRadius: 5,
                pointHoverRadius: 7,
                pointBackgroundColor: colors.secondary,
                pointBorderColor: '#fff',
                pointBorderWidth: 2,
                yAxisID: 'y1'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        usePointStyle: true,
                        padding: 15,
                        font: {
                            size: 13,
                            weight: '500'
                        }
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    padding: 12,
                    titleFont: {
                        size: 14,
                        weight: '600'
                    },
                    bodyFont: {
                        size: 13
                    },
                    borderColor: colors.primary,
                    borderWidth: 1,
                    cornerRadius: 8
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: {
                        color: 'rgba(0, 0, 0, 0.05)'
                    },
                    ticks: {
                        callback: function(value) {
                            return '$' + value.toLocaleString();
                        }
                    }
                },
                y1: {
                    type: 'linear',
                    display: true,
                    position: 'right',
                    beginAtZero: true,
                    grid: {
                        drawOnChartArea: false
                    }
                },
                x: {
                    grid: {
                        display: false
                    }
                }
            }
        }
    });
}

function updateUsersChart(data) {
    const ctx = document.getElementById('usersChart').getContext('2d');
    
    if (usersChart) {
        usersChart.destroy();
    }

    usersChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: data.map(d => {
                const date = new Date(d.date);
                return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            }),
            datasets: [{
                label: 'Total Users',
                data: data.map(d => d.users),
                backgroundColor: colors.gradient.map(c => c + '80'),
                borderColor: colors.primary,
                borderWidth: 2,
                borderRadius: 8,
                borderSkipped: false
            }, {
                label: 'New Users',
                data: data.map(d => d.new_users),
                backgroundColor: colors.success + '80',
                borderColor: colors.success,
                borderWidth: 2,
                borderRadius: 8,
                borderSkipped: false
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        usePointStyle: true,
                        padding: 15,
                        font: {
                            size: 13,
                            weight: '500'
                        }
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    padding: 12,
                    titleFont: {
                        size: 14,
                        weight: '600'
                    },
                    bodyFont: {
                        size: 13
                    },
                    borderColor: colors.success,
                    borderWidth: 1,
                    cornerRadius: 8
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: {
                        color: 'rgba(0, 0, 0, 0.05)'
                    },
                    ticks: {
                        callback: function(value) {
                            return value.toLocaleString();
                        }
                    }
                },
                x: {
                    grid: {
                        display: false
                    },
                    ticks: {
                        maxRotation: 45,
                        minRotation: 45
                    }
                }
            }
        }
    });
}

function updateRevenueChart(data) {
    const ctx = document.getElementById('revenueChart').getContext('2d');
    
    if (revenueChart) {
        revenueChart.destroy();
    }

    revenueChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: data.map(d => d.category),
            datasets: [{
                data: data.map(d => d.revenue),
                backgroundColor: colors.gradient,
                borderColor: '#fff',
                borderWidth: 3,
                hoverOffset: 10
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    position: 'right',
                    labels: {
                        usePointStyle: true,
                        padding: 15,
                        font: {
                            size: 13,
                            weight: '500'
                        }
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    padding: 12,
                    titleFont: {
                        size: 14,
                        weight: '600'
                    },
                    bodyFont: {
                        size: 13
                    },
                    callbacks: {
                        label: function(context) {
                            const label = context.label || '';
                            const value = context.parsed || 0;
                            const total = context.dataset.data.reduce((a, b) => a + b, 0);
                            const percentage = ((value / total) * 100).toFixed(1);
                            return `${label}: $${value.toLocaleString()} (${percentage}%)`;
                        }
                    },
                    borderColor: colors.primary,
                    borderWidth: 1,
                    cornerRadius: 8
                }
            }
        }
    });
}

function updateStats(salesData, usersData, revenueData) {
    // Calculate totals
    const totalSales = salesData.reduce((sum, d) => sum + d.sales, 0);
    const latestUsers = usersData[usersData.length - 1]?.users || 0;
    const totalRevenue = revenueData.reduce((sum, d) => sum + d.revenue, 0);

    // Update DOM
    document.getElementById('totalSales').textContent = '$' + totalSales.toLocaleString();
    document.getElementById('activeUsers').textContent = latestUsers.toLocaleString();
    document.getElementById('totalRevenue').textContent = '$' + totalRevenue.toLocaleString();
}
