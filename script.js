function showsideBar() {
    const sidebar = document.querySelector('.sidebar');
    sidebar.style.display = 'flex';
}

function hidesideBar() {
    const sidebar = document.querySelector('.sidebar');
    sidebar.style.display = 'none';
}

function getUserLocation() {
    if (!navigator.geolocation) {
        alert("Geolocation is not supported by this device.");
        return;
    }

    navigator.geolocation.getCurrentPosition(
        function(position) {
            const latitude = position.coords.latitude;
            const longitude = position.coords.longitude;

            console.log("Your latitude:", latitude);
            console.log("Your longitude:", longitude);

            document.getElementById("latitude").textContent = latitude.toFixed(6);
            document.getElementById("longitude").textContent = longitude.toFixed(6);

            getNearestEarthquake(latitude, longitude);
        },
        function(error) {
            console.error("Location error:", error);

            switch (error.code) {
                case error.PERMISSION_DENIED:
                    alert("Location permission was denied.");
                    break;
                case error.POSITION_UNAVAILABLE:
                    alert("Location information is unavailable.");
                    break;
                case error.TIMEOUT:
                    alert("Location request timed out.");
                    break;
                default:
                    alert("An unknown location error occurred.");
            }
        },
        {
            enableHighAccuracy: true,
            timeout: 15000,
            maximumAge: 0
        }
    );
}

async function getNearestEarthquake(userLatitude, userLongitude) {
    const url =
        "https://www.seismicportal.eu/fdsnws/event/1/query" +
        "?format=json" +
        "&limit=100" +
        "&orderby=time-desc";

    try {
        console.log("Retrieving earthquake data...");

        const response = await fetch(url);

        if (!response.ok) {
            throw new Error("HTTP error: " + response.status);
        }

        const data = await response.json();

        console.log("Earthquake data:", data);

        if (!data.features || data.features.length === 0) {
            document.getElementById("nearest-earthquake").innerHTML =
                "<p>No earthquake data available.</p>";
            return;
        }

        let nearestEarthquake = null;
        let nearestDistance = Infinity;

        data.features.forEach(function(earthquake) {
            const properties = earthquake.properties;
            const geometry = earthquake.geometry;

            if (!geometry || !geometry.coordinates) {
                return;
            }

            const longitude = geometry.coordinates[0];
            const latitude = geometry.coordinates[1];
            const depth = geometry.coordinates.length > 2
                ? geometry.coordinates[2]
                : "Unknown";

            const magnitude = properties.mag ?? "Unknown";
            const location = properties.flynn_region ||
                properties.place ||
                "Unknown location";

            const time = properties.time || "Unknown";

            const distance = calculateDistance(
                userLatitude,
                userLongitude,
                latitude,
                longitude
            );

            if (distance < nearestDistance) {
                nearestDistance = distance;

                nearestEarthquake = {
                    latitude: latitude,
                    longitude: longitude,
                    magnitude: magnitude,
                    depth: depth,
                    location: location,
                    time: time
                };
            }
        });

        if (!nearestEarthquake) {
            document.getElementById("nearest-earthquake").innerHTML =
                "<p>No earthquake found.</p>";
            return;
        }

        displayNearestEarthquake(
            nearestEarthquake,
            nearestDistance
        );

    } catch (error) {
        console.error("Earthquake retrieval error:", error);

        document.getElementById("nearest-earthquake").innerHTML =
            "<p>Unable to retrieve earthquake data.</p>";
    }
}

function calculateDistance(lat1, lon1, lat2, lon2) {
    const earthRadius = 6371;

    const latDifference = degreesToRadians(lat2 - lat1);
    const lonDifference = degreesToRadians(lon2 - lon1);

    const a =
        Math.sin(latDifference / 2) ** 2 +
        Math.cos(degreesToRadians(lat1)) *
        Math.cos(degreesToRadians(lat2)) *
        Math.sin(lonDifference / 2) ** 2;

    const c = 2 * Math.atan2(
        Math.sqrt(a),
        Math.sqrt(1 - a)
    );

    return earthRadius * c;
}

function degreesToRadians(degrees) {
    return degrees * (Math.PI / 180);
}

function displayNearestEarthquake(earthquake, distance) {
    let earthquakeTime = earthquake.time;

    if (earthquake.time !== "Unknown") {
        earthquakeTime = new Date(earthquake.time).toLocaleString();
    }

    document.getElementById("nearest-earthquake").innerHTML = `
        <p><strong>Location:</strong> ${earthquake.location}</p>
        <p><strong>Magnitude:</strong> ${earthquake.magnitude}</p>
        <p><strong>Distance:</strong> ${distance.toFixed(2)} km</p>
        <p><strong>Depth:</strong> ${earthquake.depth} km</p>
        <p><strong>Latitude:</strong> ${earthquake.latitude.toFixed(6)}</p>
        <p><strong>Longitude:</strong> ${earthquake.longitude.toFixed(6)}</p>
        <p><strong>Date and Time:</strong> ${earthquakeTime}</p>
    `;
}