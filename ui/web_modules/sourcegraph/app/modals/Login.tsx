import * as React from "react";

import { RouterLocation } from "sourcegraph/app/router";
import { LocationStateModal } from "sourcegraph/components/Modal";
import * as styles from "sourcegraph/components/styles/modal.css";
import { LoginForm } from "sourcegraph/user/Login";

interface Props {
	location: RouterLocation;
}

export const Login = (props: Props): JSX.Element => {
	const sx = {
		maxWidth: "420px",
		marginLeft: "auto",
		marginRight: "auto",
	};

	return (
		<LocationStateModal modalName="login">
			<div className={styles.modal} style={sx}>
				<LoginForm
					returnTo={props.location}
					location={props.location} />
			</div>
		</LocationStateModal>
	);
};
