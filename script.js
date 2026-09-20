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

            console.log("Latitude:", latitude);
            console.log("Longitude:", longitude);

            document.getElementById("latitude").textContent =
                latitude;

            document.getElementById("longitude").textContent =
                longitude;
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
            timeout: 10000,
            maximumAge: 0
        }
    );
}