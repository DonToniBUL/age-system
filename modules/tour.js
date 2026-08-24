export async function registerAgeSystemTour() {
    const key = "age-system.age-system-5";
    if (game.tours.has(key)) return game.tours.get(key);
    try {
        const tour = await foundry.nue.Tour.fromJSON("systems/age-system/tours/age-system-5.json");
        game.tours.register("age-system", "age-system-5", tour);
        return tour;
    } catch (error) {
        console.warn("AGE System | Could not register AGE 5 tour.", error);
        return null;
    }
}

export default registerAgeSystemTour;
