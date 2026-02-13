// Fetch data from API
async function fetchData() {
    try {
        const response = await fetch('/api/data');
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error fetching data:', error);
        return null;
    }
}

// Initialize charts
async function initCharts() {
    const data = await fetchData();
    
    if (!data) {
        console.error('Failed to load data');
        return;
    }

    // Calculate totals
    const totalSales = data.sales.reduce((a, b) => a + b, 0);
    const totalVisitors = data.visitors.reduce((a, b) => a + b, 0);
    const totalRevenue = data.revenue.reduce((a, b) => a + b, 0);

    // Update stat boxes
    document.getElementById('totalSales').textContent = totalSales.toLocaleString();
    document.getElementById('totalVisitors').textContent = totalVisitors.toLocaleString();
    document.getElementById('totalRevenue').textContent = '$' + totalRevenue.toLocaleString();

    // Chart configuration
    const chartOptions = {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
            legend: {
                display: true,
                position: 'top',
            },
        },
        scales: {
            y: {
                beginAtZero: true,
                grid: {
                    color: 'rgba(0, 0, 0, 0.05)',
                },
            },
            x: {
                grid: {
                    display: false,
                },
            },
        },
    };

    // Sales Chart (Line Chart)
    const salesCtx = document.getElementById('salesChart').getContext('2d');
    new Chart(salesCtx, {
        type: 'line',
        data: {
            labels: data.labels,
            datasets: [{
                label: 'Sales',
                data: data.sales,
                borderColor: 'rgb(102, 126, 234)',
                backgroundColor: 'rgba(102, 126, 234, 0.1)',
                borderWidth: 3,
                fill: true,
                tension: 0.4,
                pointRadius: 5,
                pointHoverRadius: 7,
            }],
        },
        options: chartOptions,
    });

    // Visitors Chart (Bar Chart)
    const visitorsCtx = document.getElementById('visitorsChart').getContext('2d');
    new Chart(visitorsCtx, {
        type: 'bar',
        data: {
            labels: data.labels,
            datasets: [{
                label: 'Visitors',
                data: data.visitors,
                backgroundColor: 'rgba(118, 75, 162, 0.7)',
                borderColor: 'rgb(118, 75, 162)',
                borderWidth: 2,
                borderRadius: 5,
            }],
        },
        options: chartOptions,
    });

    // Revenue Chart (Area Chart)
    const revenueCtx = document.getElementById('revenueChart').getContext('2d');
    new Chart(revenueCtx, {
        type: 'line',
        data: {
            labels: data.labels,
            datasets: [{
                label: 'Revenue ($)',
                data: data.revenue,
                borderColor: 'rgb(255, 99, 132)',
                backgroundColor: 'rgba(255, 99, 132, 0.2)',
                borderWidth: 3,
                fill: true,
                tension: 0.4,
                pointRadius: 5,
                pointHoverRadius: 7,
            }],
        },
        options: chartOptions,
    });
}

// Initialize when page loads
document.addEventListener('DOMContentLoaded', initCharts);
